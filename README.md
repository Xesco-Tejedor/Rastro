# Rastro · Rastreador de libros

**Demo:** https://xesco-tejedor.github.io/Rastro/

Busca un libro por título, autor, palabras clave o ISBN y rastrea dónde conseguirlo. Principio básico: **solo muestra lo que cada fuente confirma en el momento de la búsqueda**; lo que no se puede comprobar automáticamente se ofrece como búsqueda preparada en la tienda, nunca como un resultado confirmado.

## Qué consulta de verdad (JSON en directo desde el navegador)

| Fuente | Qué aporta |
|---|---|
| Open Library | Fichas bibliográficas y ejemplares digitales. |
| Archive.org | Ejemplares de acceso gratuito (lectura en línea o préstamo con cuenta gratuita). |
| Casa del Libro | Precio y disponibilidad online en el momento de la búsqueda (API pública de su catálogo). |
| Google Books | Fichas y, cuando existe, precio del eBook en Google Play. Si la cuota gratuita está agotada, la app lo indica. |

## Búsqueda directa (se abre la tienda con la búsqueda preparada)

- **IberLibro** y **AbeBooks** (segunda mano)
- **Amazon**
- **La Central**
- **Laie**

En estas tiendas el precio, el estado del ejemplar y el stock se comprueban en su propia web.

## Uso

1. Escribe un título, autor o ISBN y pulsa **Rastrear**.
2. **Acceso gratuito**: si hay ejemplar digital, el enlace abre Archive.org.
3. **Casa del Libro**: precio y disponibilidad reales.
4. **Otras tiendas**: pulsa una tienda para abrir su web con la búsqueda ya escrita.
5. Toca una ficha para ver el detalle con ISBN y enlaces a todas las tiendas.

## Técnica

HTML + CSS + JS estáticos, sin servidor ni claves. Las consultas salen del navegador del usuario contra las APIs públicas de Open Library, Archive.org, Casa del Libro (Empathy) y Google Books. No se guarda ni se envía ningún dato personal.
