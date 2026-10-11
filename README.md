# CEIDEF · Ideas que conectan

Aplicación para una actividad virtual de hasta **10 participantes**, construida con Vite, React, TypeScript y Supabase. No usa modelos de IA. El moderador no ocupa un lugar de participante.

## Pasos manuales en Supabase

1. **Ejecutar el SQL.** Abrí el proyecto → **SQL Editor**, pegá el contenido completo de [`supabase/setup.sql`](supabase/setup.sql) y ejecutalo. Se instala una actividad en fase `waiting`, las siete áreas, tablas, restricciones, RLS, triggers, RPC y la publicación de fases en Realtime. El script se ejecuta **una sola vez** en un proyecto sin estas tablas: no borra ni reemplaza datos existentes y no es una migración idempotente. Si falla, la transacción revierte la instalación.
2. **Habilitar sesiones anónimas.** En **Authentication**, en la configuración de proveedores / inicio de sesión, activá **Allow anonymous sign-ins**. Un participante anónimo recibe un usuario de Auth con UUID y el rol `authenticated`; la publishable key por sí sola no permite leer ideas. [Documentación oficial](https://supabase.com/docs/guides/auth/auth-anonymous).
3. **Crear la cuenta de moderación.** En **Authentication → Users → Add user**, creá un usuario de correo y contraseña con correo confirmado. Activá el proveedor Email si estaba deshabilitado. No hay un formulario de registro de moderadores en la aplicación. Copiá el UUID de esta cuenta, que debe ser un usuario permanente, no anónimo.
4. **Asignar permisos en la base de datos.** Ejecutá en el SQL Editor, reemplazando el UUID:

   ```sql
   insert into ceidef_private.moderators (user_id)
   values ('UUID-DE-LA-CUENTA-DE-MODERACION')
   on conflict do nothing;
   ```

   Esta asignación solo se hace desde el SQL Editor. Ni un usuario anónimo ni una cuenta de correo sin esta fila pueden moderar. Para revocar permisos:

   ```sql
   delete from ceidef_private.moderators
   where user_id = 'UUID-DE-LA-CUENTA-DE-MODERACION';
   ```

5. **Verificar API y Realtime.** Dejá `public` entre los esquemas expuestos de la Data API. **No expongas `ceidef_private`**. El SQL agrega `public.workshops` a `supabase_realtime`. En la configuración de replicación / publicaciones comprobá que se publique **solamente `workshops` de las tablas de esta aplicación**. No agregues `ideas`, `classifications` ni `participants`: la aplicación las consulta con RLS y nunca publica votos individuales en Realtime. Si ya existía una publicación `FOR ALL TABLES`, usá un proyecto dedicado o reemplazá esa configuración antes de usar la actividad. [Realtime oficial](https://supabase.com/docs/guides/realtime/postgres-changes).
6. **Configurar el dominio.** En **Authentication → URL Configuration**, establecé la **Site URL** del hosting definitivo. Este flujo usa correo/contraseña y sesión anónima, sin enlaces de correo ni callbacks de OAuth. Si habilitás otros flujos de Auth posteriormente, agregá sus redirect URLs explícitos.

## Desarrollo local

Requiere Node.js **24+** (las pruebas usan TypeScript nativo de Node). Las variables ya disponibles en `.env.local` deben tener estos nombres:

```dotenv
VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_REEMPLAZAR
```

Podés copiar `.env.example` para un nuevo entorno. `.env.local` está ignorado por Git. No pongas una secret key ni `service_role` en ninguna variable `VITE_*`: todas esas variables terminan en el navegador. La URL y la publishable key están diseñadas para ser públicas; la protección está en RLS y los permisos de la base de datos.

```sh
npm ci
npm run dev
```

En PowerShell, si la política de ejecución bloquea `npm.ps1`, usá **`npm.cmd`** en lugar de `npm`. Reiniciá Vite si cambiás las variables de entorno.

Compartí la URL principal con los participantes. Abrí **`/?moderador`** o el botón **Moderación** para ingresar con la cuenta habilitada. Usá un perfil de navegador diferente para moderar y participar simultáneamente: una sesión de Auth corresponde a un usuario por navegador/origen. Un intento de acceso con una cuenta sin permisos conserva la sesión del participante.

## Uso de la actividad

1. **Espera.** Los participantes escriben su nombre (1–60 caracteres) y entran sin cuenta ni contraseña. El ingreso es idempotente y la base limita los lugares a 10. El moderador ve la lista y pulsa **Comenzar escritura**. **El ingreso de nuevas personas se cierra al comenzar**; quienes ya ingresaron pueden volver con su sesión durante cualquier fase.
2. **Ideas.** Cada participante guarda hasta 3 post-its de 1–500 caracteres y solo lee los suyos. Puede editarlos o eliminarlos. El equipo organizador agrega sus propias ideas, identificadas como **Equipo organizador**; estas no tienen el límite de 3. El moderador puede leer todas las ideas y exportarlas, pero solo editar/eliminar las que creó. Al pulsar **Cerrar escritura**, el mural pasa a ser visible a todos los miembros.
3. **Clasificación.** Cada participante elige una de las siete áreas por idea, incluidas las ideas del equipo y las propias. Cada cambio se guarda inmediatamente. La clave primaria `(user_id, idea_id)` impide duplicados; el upsert solo cambia el área. Las elecciones ajenas permanecen ocultas, incluso al moderador. El panel de moderación muestra solo nombres y cantidades completadas. **Mostrar resultados** pide confirmación e informa las respuestas guardadas, aun si faltan participantes por terminar.
4. **Resultados.** Cada idea muestra las siete áreas (también las que tienen cero elecciones) y el total de respuestas. El total puede ser menor que el número de participantes si quedaron ideas sin clasificar. Las escrituras quedan cerradas; el moderador descarga **Ideas CSV** y **Resultados CSV**.

Los cambios de fase avanzan solamente en orden y no se pueden deshacer desde la interfaz. La actividad permanece disponible para consulta hasta que el administrador ejecute el reinicio manual descrito abajo. No hay un botón de reinicio en la aplicación.

## Reiniciar y dejar la actividad en blanco

1. Descargá **Ideas CSV** y **Resultados CSV** si querés conservar el encuentro anterior. El reinicio borra definitivamente los participantes, las ideas (incluidas las del equipo organizador) y las clasificaciones.
2. Entre encuentros, abrí **Supabase → SQL Editor** con el rol administrador `postgres`. Pegá y ejecutá **todo** [`supabase/reset.sql`](supabase/reset.sql). No vuelvas a ejecutar `setup.sql`.
3. Recargá la aplicación. La fase vuelve a **Espera**, el mural queda vacío y se liberan los 10 lugares. Los participantes deben volver a ingresar su nombre; pueden usar la misma sesión anónima del navegador. El moderador conserva su cuenta y sus permisos. No se necesita reconstruir ni publicar el frontend.

El script conserva las siete áreas, los usuarios de Auth, la configuración, las políticas RLS y las funciones. El borrado y el cambio de fase ocurren en una única transacción. Los locks `NOWAIT` hacen que se cancele si una operación concurrente impide bloquear las tablas: si aparece un error de bloqueo (`55P03`), ejecutá `ROLLBACK;`, cerrá las pestañas de participantes y volvé a ejecutar el archivo completo. No desactives los triggers ni RLS.

Usa `TRUNCATE` porque los triggers de esta aplicación bloquean `DELETE` de ideas fuera de la fase de escritura y sobre ideas ajenas. `TRUNCATE` no ejecuta triggers de borrado de filas y su efecto se revierte si la transacción no confirma. [Documentación de PostgreSQL](https://www.postgresql.org/docs/current/sql-truncate.html).

## Persistencia y sincronización

- Supabase almacena nombres, ideas, clasificaciones y fase. Auth conserva y renueva la sesión en el almacenamiento del navegador. Recargar no elimina datos ni requiere volver a escribir el nombre.
- Realtime notifica los cambios de fase. Cada cliente también relee los datos cada **5 segundos**, al recuperar foco y al volver la conexión. Esto actualiza el progreso y cubre cortes de Realtime. Las lecturas respetan RLS.
- Se muestran carga inicial, guardado, confirmación y errores. Una escritura fallida conserva el texto para reintentar. No se muestran elecciones como guardadas hasta que Supabase confirma. Sin conexión no hay guardado offline.
- Una sesión anónima no puede recuperarse por nombre si se borran los datos del navegador, se usa otro dispositivo/origen o se cierra esa sesión. Los participantes no tienen un botón de logout. [Limitaciones de sesiones anónimas](https://supabase.com/docs/guides/auth/auth-anonymous).
- Los CSV usan UTF-8 con BOM, comillas y saltos de línea escapados, e incluyen ceros. Se neutralizan valores que podrían interpretarse como fórmulas al abrirlos en una planilla.

## Protección en la base de datos

[`supabase/setup.sql`](supabase/setup.sql) usa RLS en todas las tablas de la aplicación y en la tabla privada de moderadores. Las tablas públicas no otorgan permisos al rol `anon`. Los participantes se crean mediante `join_workshop`, que deriva el UUID de `auth.uid()` y verifica fase y capacidad. No hay permisos de escritura directa sobre participantes, fases, áreas o moderadores.

Las políticas limitan la lectura de ideas según usuario/fase y la lectura de clasificaciones al propio autor. Las escrituras tienen validación de fase en **RLS y triggers**. Los permisos de columna y triggers impiden cambiar autores, identidades o la marca de organizador. La validación del máximo de ideas bloquea la fila de participante; el ingreso bloquea la actividad. Todas las escrituras de ideas y clasificaciones toman un lock de la actividad que se coordina con el cierre de fase, para impedir escrituras fuera de tiempo con solicitudes concurrentes.

Las funciones `get_progress` y `get_results` devuelven agregados, con controles de acceso explícitos. `get_results` se habilita solamente en resultados. Las funciones `SECURITY DEFINER` tienen `search_path` fijo y permisos de ejecución limitados; `classify_idea` es `SECURITY INVOKER` y conserva RLS. [RLS oficial](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Verificación

```sh
npm test
npm run test:e2e
npm run lint
npm run build
```

- `npm test` ejecuta el **SQL completo sin modificar** en PostgreSQL 18 mediante PGlite, con roles `anon`/`authenticated` y JWT simulados. Verifica permisos, ingreso, límites, propiedad, fases, edición/eliminación, voto único modificable, privacidad de votos, agregados con ceros y publicación de Realtime. También verifica los CSV. Auth se representa con las funciones/esquema que Supabase aporta: no hace llamadas a tu proyecto.
- `npm run test:e2e` recorre la aplicación en escritorio y móvil con HTTP de Supabase simulado: dos participantes, login de moderación, todas las fases, edición/eliminación, límite de post-its, privacidad visual, cambios de clasificación, recarga, CSV, errores/reintentos y denegación de un moderador sin permisos. No prueba el servicio remoto ni una conexión Realtime real. En Windows usa Edge instalado. En otros sistemas instalá Chromium con `npx playwright install chromium`; opcionalmente establecé `PLAYWRIGHT_EXECUTABLE_PATH`. Capturas y trazas se guardan en `test-results/` y se ignoran en Git. El servidor de prueba usa variables ficticias y no cambia `.env.local`.

Después de configurar Supabase, hacé una prueba real: un navegador para moderación y dos perfiles independientes para participantes. Confirmá que una recarga conserve el nombre y los datos, que la otra persona no vea tus ideas durante escritura, que ambos vean el mural en clasificación y que los resultados reflejen sus elecciones. Para validar permisos, usá tokens de participante a través de la API (el SQL Editor como `postgres` omite RLS y no representa un participante). Todavía deben verificarse en tu proyecto Auth, la Data API y Realtime, porque el SQL y la configuración se aplican manualmente.

## Publicación

Esta es una SPA estática: Supabase es el backend y no se necesita servidor Node en producción.

1. Subí el repositorio al proveedor de hosting elegido, sin `.env.local`.
2. Configurá **`VITE_SUPABASE_URL`** y **`VITE_SUPABASE_PUBLISHABLE_KEY`** como variables del build, con los mismos valores públicos que en local.
3. Usá **`npm ci`**, comando de build **`npm run build`** y carpeta de publicación **`dist`**. En Netlify, Vercel o Cloudflare Pages podés seleccionar el preset Vite. El flujo usa la raíz y query strings, sin rutas que necesiten reescritura.
4. Publicá por HTTPS, actualizá la Site URL en Supabase y compartí el enlace definitivo. El almacenamiento de sesión pertenece al origen: no cambies de dominio durante el encuentro.
5. Si servís desde una subcarpeta, configurá `base` en `vite.config.ts` y reconstruí; usá la URL de esa subcarpeta, con `?moderador` para el equipo.

No se aplicó SQL a tu Supabase ni se publicó el sitio automáticamente. El frontend no incluye claves secretas ni `service_role`.
