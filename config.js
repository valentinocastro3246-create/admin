// =====================================================================
// CONEXIÓN CON SUPABASE (se completa una sola vez por cliente)
// Supabase > Project Settings > API:
//   - "Project URL"                       -> SUPABASE_URL
//   - "Publishable key" (sb_publishable_) -> SUPABASE_CLAVE_PUBLICA
//     (si tu proyecto todavía usa la clave "anon", pegá esa)
// NUNCA pegues acá la "secret key" ni la "service_role".
// =====================================================================
window.PRO_CONFIG = {
    SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
    SUPABASE_CLAVE_PUBLICA: "sb_publishable_TU_CLAVE"
};
