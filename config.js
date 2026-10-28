// Connexion au projet Supabase.
// Ces deux valeurs sont publiques par conception : la sécurité repose sur les règles d'accès
// (RLS) définies dans supabase/schema.sql. Ne mettez JAMAIS ici la clé « service_role » ou « secret ».
window.BO_CONFIG = {
  supabaseUrl: "https://ptujctckwtgszzoidwhc.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0dWpjdGNrd3Rnc3p6b2lkd2hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxNzE3NDYsImV4cCI6MjEwODc0Nzc0Nn0.y079lldAPIqAbWWmcDvkZweVfEItv68_vo9M-ghzyN0",
  bucket: "justificatifs",
};
