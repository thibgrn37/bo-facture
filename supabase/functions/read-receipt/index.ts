// Fonction serveur « read-receipt » : lit une photo de ticket ou de facture avec Claude
// et renvoie les champs extraits. La clé API Anthropic reste ici, côté serveur
// (secret ANTHROPIC_API_KEY), et n'est jamais envoyée au téléphone.
import Anthropic from "npm:@anthropic-ai/sdk@0.135.0";
import { createClient } from "npm:@supabase/supabase-js@2.115.0";

const MODEL = Deno.env.get("RECEIPT_MODEL") ?? "claude-opus-5-5";
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const nullable = (type: string) => ({ type: [type, "null"] });
const schema = (categories: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: [
    "fournisseur", "date", "montant_ttc", "montant_ht", "tva", "numero", "categorie",
    "description", "moyen_paiement", "carte_4_derniers", "a_payer", "echeance",
  ],
  properties: {
    fournisseur: { type: "string" },
    date: nullable("string"),
    montant_ttc: nullable("number"),
    montant_ht: nullable("number"),
    tva: nullable("number"),
    numero: nullable("string"),
    categorie: { type: "string", enum: categories },
    description: { type: "string" },
    moyen_paiement: { type: "string", enum: ["carte", "especes", "virement", "cheque", "prelevement", "inconnu"] },
    carte_4_derniers: nullable("string"),
    a_payer: { type: "boolean" },
    echeance: nullable("string"),
  },
});

const prompt = `Tu lis un justificatif d'achat (ticket de caisse, facture ou note de frais) d'une petite entreprise française. Les images jointes sont la photo ou les pages de ce justificatif.
Remplis les champs :
- fournisseur : nom du commerçant ou de l'entreprise émettrice.
- date : date d'achat ou de facture au format AAAA-MM-JJ.
- montant_ttc : total payé TTC. montant_ht : total HT. tva : montant total de TVA. Nombres avec un point décimal.
- numero : numéro de facture ou de ticket.
- categorie : la catégorie la plus adaptée parmi la liste autorisée.
- description : ce qui a été acheté, en 3 à 8 mots.
- moyen_paiement : le moyen de paiement imprimé sur le justificatif, ou "inconnu".
- carte_4_derniers : les 4 derniers chiffres de la carte bancaire s'ils sont imprimés (par ex. "XXXX XXXX XXXX 1234" donne "1234").
- a_payer : true seulement si c'est une facture pas encore réglée (échéance à venir, "à régler").
- echeance : date d'échéance au format AAAA-MM-JJ.
Mets null pour toute valeur absente ou illisible ; n'invente rien.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Seuls les associés connectés et autorisés peuvent utiliser la lecture automatique.
  const auth = req.headers.get("Authorization") ?? "";
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: isMember, error: memberErr } = await supa.rpc("is_member");
  if (memberErr || !isMember) return json({ error: "not_allowed" }, 403);

  if (!Deno.env.get("ANTHROPIC_API_KEY")) return json({ error: "missing_api_key" }, 500);

  let body: { images?: { media_type: string; data: string }[]; categories?: string[] };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const images = (body.images ?? []).slice(0, MAX_IMAGES).filter((im) =>
    ["image/jpeg", "image/png", "image/webp"].includes(im.media_type) &&
    typeof im.data === "string" && im.data.length * 0.75 <= MAX_IMAGE_BYTES
  );
  if (!images.length) return json({ error: "no_image" }, 400);
  const categories = (body.categories ?? []).filter((c) => typeof c === "string" && c.trim()).slice(0, 60);
  if (!categories.length) categories.push("Autre");

  const client = new Anthropic(); // lit ANTHROPIC_API_KEY
  const content = [
    ...images.map((im) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: im.media_type, data: im.data },
    })),
    { type: "text" as const, text: prompt },
  ];

  const params = {
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: schema(categories) } },
    messages: [{ role: "user", content }],
  };

  try {
    // 1) sortie JSON garantie + repli automatique si un filtre de sécurité refuse
    // 2) même chose sans le repli (paramètre bêta)
    // 3) sans format imposé : le texte demande déjà un objet JSON
    const plain = { ...params, output_config: { effort: "low" }, messages: [{ role: "user", content: [
      ...content.slice(0, -1), { type: "text" as const, text: prompt + "\nRéponds uniquement avec l'objet JSON (clés ci-dessus), sans texte autour." },
    ] }] };
    const attempts = [
      // deno-lint-ignore no-explicit-any
      () => client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } as any),
      // deno-lint-ignore no-explicit-any
      () => client.messages.create(params as any),
      // deno-lint-ignore no-explicit-any
      () => client.messages.create(plain as any),
    ];
    // deno-lint-ignore no-explicit-any
    let response: any;
    for (let i = 0; i < attempts.length; i++) {
      try { response = await attempts[i](); break; } catch (e) {
        const last = i === attempts.length - 1;
        if (last || !(e instanceof Anthropic.BadRequestError) || /credit|balance|billing/i.test(String(e.message))) throw e;
        console.warn("tentative", i + 1, "refusée :", e.message);
      }
    }
    if (response.stop_reason === "refusal") return json({ error: "refused" }, 422);
    const text = response.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text ?? "")
      .join("");
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end < start) return json({ error: "unreadable" }, 422);
    return json(JSON.parse(text.slice(start, end + 1)));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 500);
    if (e instanceof Anthropic.APIError) {
      console.error("Anthropic API error", e.status, e.message);
      return json({ error: "api_error", status: e.status, detail: String(e.message ?? "").slice(0, 300) }, 502);
    }
    console.error(e);
    return json({ error: "server_error", detail: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
