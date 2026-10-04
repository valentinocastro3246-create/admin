-- =====================================================================
-- CREAR EL ADMINISTRADOR (se hace una sola vez por cliente)
-- =====================================================================
-- 1) En Supabase > Authentication > Users > "Add user" > "Create new user":
--    poné el email y una contraseña segura del dueño del negocio.
--    (Dejá tildado "Auto Confirm User".)
-- 2) Cambiá el email de abajo por ese mismo y ejecutá esta consulta en
--    SQL Editor.
-- =====================================================================

insert into public.admins (user_id)
select id from auth.users where email = 'EMAIL-DEL-DUENO@ejemplo.com'
on conflict do nothing;

-- Para comprobar que quedó: debe devolver 1 fila
select a.user_id, u.email from public.admins a join auth.users u on u.id = a.user_id;
