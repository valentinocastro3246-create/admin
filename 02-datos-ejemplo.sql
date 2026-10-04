-- =====================================================================
-- DATOS DE EJEMPLO (opcional): sirve para ver la página funcionando.
-- Ejecutalo después de 01-esquema.sql. Después los borrás o editás
-- desde el panel de administración.
-- =====================================================================

insert into public.categorias (nombre, emoji, orden) values
  ('Categoría 1', '⭐', 1),
  ('Categoría 2', '🛒', 2);

insert into public.productos (categoria_id, nombre, descripcion, precio, etiqueta, controla_stock, stock, stock_minimo, extras, quitables, orden)
select c.id, p.nombre, p.descripcion, p.precio, p.etiqueta, p.controla, p.stock, p.minimo, p.extras::jsonb, p.quitables::jsonb, p.orden
from (values
  ('Categoría 1', 'Producto de ejemplo 1', 'Descripción corta del producto.', 5000, 'Más vendido', true, 20, 5,
     '[{"nombre":"Extra de ejemplo","precio":1000}]', '["Ingrediente A","Ingrediente B"]', 1),
  ('Categoría 1', 'Producto de ejemplo 2', 'Descripción corta del producto.', 7500, '', true, 10, 3, '[]', '[]', 2),
  ('Categoría 2', 'Producto de ejemplo 3', 'Sin control de stock (siempre disponible).', 3200, '', false, 0, 0, '[]', '[]', 1)
) as p(categoria, nombre, descripcion, precio, etiqueta, controla, stock, minimo, extras, quitables, orden)
join public.categorias c on c.nombre = p.categoria;
