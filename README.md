# CEIDEF · Ideas que conectan

Aplicación para una actividad virtual de hasta **100 participantes** y **10 ideas por participante**, construida con Vite, React, TypeScript y Supabase. Cada idea tiene seis secciones. No usa modelos de IA. El moderador no ocupa un lugar de participante.

## Actualizar una base existente: campos opcionales y varias áreas

Si ya ejecutaste la versión anterior de `setup.sql`, **no lo ejecutes de nuevo ni uses `reset.sql` para actualizar**:

1. Si todavía tenés la primera versión, con un solo campo `content`, ejecutá primero [`supabase/migrations/20261011_structured_ideas.sql`](supabase/migrations/20261011_structured_ideas.sql). Si ya instalaste las seis secciones, este paso ya está hecho.
2. Entre actividades, abrí **Supabase → SQL Editor** como `postgres` y ejecutá completo [`supabase/migrations/20261011_multiple_areas.sql`](supabase/migrations/20261011_multiple_areas.sql). Habilita los cinco campos opcionales, cambia las respuestas a varias áreas y elimina el área 7.
3. Ejecutá [`supabase/migrations/20261011_preset_ideas.sql`](supabase/migrations/20261011_preset_ideas.sql) para agregar las tres ideas predeterminadas y protegerlas frente al reinicio, si todavía no lo hiciste.
4. Ejecutá completo [`supabase/migrations/20261013_join_any_phase.sql`](supabase/migrations/20261013_join_any_phase.sql) en **SQL Editor** como `postgres` para permitir ingresos en cualquier fase. Si ya tenés las ideas predeterminadas, este es el único SQL nuevo que necesitás ejecutar. No borra datos ni cambia la fase actual; conserva los 100 lugares, RLS y los cierres de escritura y clasificación.
5. Ejecutá completo [`supabase/migrations/20261013_moderator_reset.sql`](supabase/migrations/20261013_moderator_reset.sql) como `postgres` para habilitar el botón de reinicio del moderador. Instala la función y actualiza el trigger sin borrar datos ni cambiar la fase. Si ya aplicaste las migraciones anteriores, este es el único SQL nuevo para el botón.
6. Publicá el frontend actualizado (o recargá el servidor local), después de aplicar las migraciones. Recargá la aplicación para usar los nuevos controles.

Las migraciones son transaccionales y se pueden volver a ejecutar. Conservan participantes, ideas, clasificaciones, fase y permisos; no reabren fases cerradas. El texto de la primera versión queda en **Tarea**. Las respuestas anteriores conservan su área como una lista de un elemento; las que tenían **Transversal / no estoy seguro** pasan a **Sin áreas**, conservando su lugar en el total de respuestas. Los campos opcionales vacíos se omiten en las tarjetas y quedan vacíos en los CSV. Si aparece un error de bloqueo (`55P03`), ejecutá `ROLLBACK;`, cerrá las pestañas de participantes y reintentá el archivo completo. Para una base nueva, usá directamente el `setup.sql` actualizado de la sección siguiente: no necesita estas migraciones.

## Pasos manuales en Supabase

1. **Ejecutar el SQL.** Abrí el proyecto → **SQL Editor**, pegá el contenido completo de [`supabase/setup.sql`](supabase/setup.sql) y ejecutalo. Se instala una actividad en fase `waiting`, las seis áreas, tablas, restricciones, RLS, triggers, RPC y la publicación de fases en Realtime. El script se ejecuta **una sola vez** en un proyecto sin estas tablas: no borra ni reemplaza datos existentes y no es una migración idempotente. Si falla, la transacción revierte la instalación.
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

1. **Espera.** Los participantes escriben su nombre (1–60 caracteres) y entran sin cuenta ni contraseña. El ingreso es idempotente y la base limita los lugares a 100. El moderador ve la lista y pulsa **Comenzar escritura**. **El ingreso permanece abierto en todas las fases**, incluso Resultados: cada persona ve la etapa actual sin necesitar ideas ni clasificaciones previas. Entrar no reabre etapas cerradas.
2. **Ideas.** Cada participante guarda hasta 10 post-its y solo lee los suyos. **Tarea** es el único campo obligatorio (1–500 caracteres). **Puesto**, **Información que necesita**, **Quién lo supervisa**, **Lo que nunca puede hacer** y **Cómo sabremos que lo hace bien** son opcionales (hasta 500 caracteres por campo) y tienen placeholders. Puede editar la ficha o eliminarla. Las tarjetas usan letra grande y colores vivos; los campos opcionales vacíos no se muestran. El equipo organizador agrega sus propias ideas, identificadas como **Equipo organizador**; estas no tienen el límite de 10. El moderador puede leer todas las ideas y exportarlas, pero solo editar/eliminar las que creó. Al pulsar **Cerrar escritura**, el mural pasa a ser visible a todos los miembros.
3. **Clasificación.** Cada participante puede elegir **una, varias o ninguna de las seis áreas** por idea. Arrastra etiquetas desde la paleta al espacio de una tarjeta. También puede elegir una etiqueta y tocar su espacio, o usar los botones de cada área con mouse, teclado o pantalla táctil. Puede quitar etiquetas o pulsar **Guardar sin áreas**. Cada cambio se guarda inmediatamente. Quitar la última etiqueta también guarda una respuesta sin áreas. Sin una acción de guardado, la idea permanece pendiente: una respuesta explícita sin áreas sí cuenta como completada. La clave primaria `(user_id, idea_id)` mantiene una sola respuesta por participante/idea, con un array de áreas sin duplicados. Las elecciones ajenas permanecen ocultas, incluso al moderador. El panel muestra nombres y cantidades completadas. **Mostrar resultados** pide confirmación e informa las respuestas guardadas.
4. **Resultados.** Cada idea muestra las seis áreas (también las que tienen cero elecciones), **Sin áreas** y el **total de respuestas**. El total cuenta personas que respondieron, incluidas las respuestas sin áreas. La suma de elecciones por área puede superar el total porque una persona puede asignar varias etiquetas; las ideas pendientes no suman respuestas. Las escrituras quedan cerradas; el moderador descarga **Ideas CSV** y **Resultados CSV**. El CSV de resultados incluye el contador Sin áreas.

Los cambios de fase avanzan solamente en orden. El padrón del moderador se actualiza también en Resultados para mostrar nuevos ingresos, sin modificar los votos cerrados. La actividad permanece disponible para consulta hasta que el moderador o administrador la reinicie como se describe abajo.

## Ideas predeterminadas

La instalación incluye estas tres fichas completas, con sus títulos y los seis campos proporcionados:

- Asistente para revisar combinaciones de medicamentos.
- Asistente para detectar posibles problemas con medicamentos.
- Asistente para explicar el uso de medicamentos.

Se muestran desde **Clasificación** y permanecen en **Resultados** para consultar sus conteos. RLS las oculta durante **Espera** e **Ideas**, incluso a la cuenta de moderación. No ocupan lugares de participante ni consumen el límite personal de 10 ideas. Aparecen identificadas como **Idea predeterminada · Equipo organizador** y no se pueden editar o eliminar desde la aplicación. Su título se incluye en una columna adicional de los CSV.

Cada ficha tiene un UUID estable y no depende de una cuenta ficticia de Auth. La migración puede ejecutarse otra vez sin duplicarlas. El reinicio conserva los registros y su texto; borra las clasificaciones anteriores para que cada encuentro comience sin respuestas. Una vez que se vuelve a abrir Clasificación, las tres fichas aparecen de nuevo.

## Reiniciar y dejar la actividad en blanco

1. Descargá **Ideas CSV** y **Resultados CSV** si querés conservar el encuentro anterior. El reinicio borra definitivamente participantes, ideas escritas por participantes/organizadores y todas las clasificaciones, incluidas las respuestas sobre las fichas predeterminadas. **Conserva las tres ideas predeterminadas.**
2. En el panel del moderador, pulsá **Reiniciar actividad**. Revisá el popup y pulsá **Sí, reiniciar actividad**. Está disponible en cualquier fase. **Cancelar** o Escape cierran el popup sin borrar nada. Requiere la migración `20261013_moderator_reset.sql`. La base verifica los permisos del moderador; ocultar el botón no es la protección.
3. La aplicación se actualiza automáticamente: vuelve a **Espera**, oculta las ideas predeterminadas hasta Clasificación y libera los 100 lugares. Los participantes vuelven a ingresar su nombre con la misma sesión anónima; el moderador conserva su cuenta y permisos. No se necesita volver a publicar para cada reinicio.

Si la actividad cambió mientras el popup estaba abierto, cerralo y volvé a abrirlo para revisar el estado actual. Si hay una operación concurrente, el reinicio aborta sin borrar y permite reintentar. Un error durante el borrado revierte toda la operación.

Como alternativa administrativa, ejecutá completo [`supabase/reset.sql`](supabase/reset.sql) en **SQL Editor** como `postgres`, entre encuentros. Requiere las ideas predeterminadas instaladas. No vuelvas a ejecutar `setup.sql`.

Si una copia anterior de `20261013_moderator_reset.sql` falló con `permission denied to set parameter "ceidef.reset_active"`, ejecutá nuevamente el archivo actualizado completo. Si la transacción quedó abortada, ejecutá `ROLLBACK;` antes. La versión corregida usa una tabla privada de autorización por transacción, sin parámetros personalizados; los roles de la API no pueden leerla ni escribirla. Instalar o repetir esta migración no reinicia la actividad.

El script conserva las seis áreas, los usuarios de Auth, la configuración, las políticas RLS y las funciones. El borrado y el cambio de fase ocurren en una única transacción. Los locks `NOWAIT` hacen que se cancele si una operación concurrente impide bloquear las tablas: si aparece un error de bloqueo (`55P03`), ejecutá `ROLLBACK;`, cerrá las pestañas de participantes y volvé a ejecutar el archivo completo. No desactives los triggers ni RLS.

El reinicio vacía clasificaciones y participantes con `TRUNCATE`, y borra ideas no predeterminadas mediante `DELETE`. El trigger admite el borrado administrativo sin JWT o el contexto de la RPC de reinicio con un moderador verificado; una sesión normal no puede habilitar esa excepción. Las escrituras habituales conservan las restricciones de fase y autor. Un trigger bloquea `TRUNCATE` sobre `ideas`, por lo que una copia antigua del reset aborta sin borrar las fichas permanentes. Si usaste una copia anterior, ejecutá `ROLLBACK;` y usá el archivo actualizado. [TRUNCATE en PostgreSQL](https://www.postgresql.org/docs/current/sql-truncate.html).

## Persistencia y sincronización

- Supabase almacena nombres, ideas, clasificaciones y fase. Auth conserva y renueva la sesión en el almacenamiento del navegador. Recargar no elimina datos ni requiere volver a escribir el nombre.
- Realtime notifica los cambios de fase. Cada cliente también consulta la fase y sus permisos cada **5 segundos**, al recuperar foco y al volver la conexión. Esto actualiza el progreso y cubre cortes de Realtime. Las lecturas respetan RLS. El mural de clasificación ya cerrado para escritura se conserva en memoria; los resultados finales también se conservan hasta un cambio de fase/reinicio. Las elecciones propias y el progreso de clasificación sí se actualizan mientras esa fase está abierta.
- Las lecturas de ideas, clasificaciones y agregados se paginan en bloques de **500 filas** para cubrir 1.000 ideas de participantes, las del equipo y todas las áreas de resultados. Mantené el límite de filas de la Data API en su valor habitual de 1.000 o, al menos, en 500. La aplicación no necesita aumentar ese límite a 6.000.
- Se muestran carga inicial, guardado, confirmación y errores. Una escritura fallida conserva el texto para reintentar. No se muestran elecciones como guardadas hasta que Supabase confirma. Sin conexión no hay guardado offline.
- Una sesión anónima no puede recuperarse por nombre si se borran los datos del navegador, se usa otro dispositivo/origen o se cierra esa sesión. Se puede ingresar de nuevo en cualquier fase, pero será una participación nueva, ocupará otro de los 100 lugares y no heredará ideas ni respuestas anteriores. Con la misma sesión del navegador se conserva la participación al recargar o reconectar. Los participantes no tienen un botón de logout. [Limitaciones de sesiones anónimas](https://supabase.com/docs/guides/auth/auth-anonymous).
- Los CSV incluyen el título y una columna por cada una de las seis secciones, usan UTF-8 con BOM, comillas y saltos de línea escapados, e incluyen ceros. Se neutralizan valores que podrían interpretarse como fórmulas al abrirlos en una planilla. Las fichas predeterminadas se incluyen al exportar desde Clasificación o Resultados.

## Protección en la base de datos

[`supabase/setup.sql`](supabase/setup.sql) usa RLS en todas las tablas de la aplicación y en la tabla privada de moderadores. Las tablas públicas no otorgan permisos al rol `anon`. Los participantes se crean mediante `join_workshop`, que deriva el UUID de `auth.uid()`, valida el nombre y la capacidad, y permite todas las fases. No hay permisos de escritura directa sobre participantes, fases, áreas o moderadores.

Las políticas limitan la lectura de ideas según usuario/fase y la lectura de clasificaciones al propio autor. Las escrituras tienen validación de fase en **RLS y triggers**. Los permisos de columna y triggers impiden cambiar autores, identidades o la marca de organizador. Las respuestas admiten un array vacío o IDs del 1 al 6; rechazan valores nulos/ajenos y normalizan duplicados. La validación del máximo de ideas bloquea la fila de participante; el ingreso bloquea la actividad. Todas las escrituras de ideas y clasificaciones toman un lock de la actividad que se coordina con el cierre de fase, para impedir escrituras fuera de tiempo con solicitudes concurrentes.

Las funciones `get_progress` y `get_results` devuelven agregados, con controles de acceso explícitos. `get_results` se habilita solamente en resultados. Las funciones `SECURITY DEFINER` tienen `search_path` fijo y permisos de ejecución limitados; `classify_idea` es `SECURITY INVOKER` y conserva RLS. [RLS oficial](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Verificación

```sh
npm test
npm run test:e2e
npm run lint
npm run build
```

- `npm test` ejecuta el **SQL completo sin modificar** en PostgreSQL 18 mediante PGlite, con roles `anon`/`authenticated` y JWT simulados. Verifica permisos, rechazo del participante 101 y de la idea 11, Tarea obligatoria y cinco campos opcionales, propiedad, fases, edición/eliminación, respuesta única con varias áreas o ninguna, privacidad de votos, agregados con ceros, reinicio y publicación de Realtime. Prueba las migraciones desde esquemas anteriores congelados, incluidos los datos y votos previos. Verifica que las tres predeterminadas estén ocultas antes de clasificar, sean inmutables, no se dupliquen y sobrevivan a reinicios repetidos, mientras sus votos se eliminan. También verifica los CSV y la paginación de 6.006 filas. Auth se representa con las funciones/esquema que Supabase aporta: no hace llamadas a tu proyecto.
- `npm run test:e2e` recorre la aplicación en escritorio y móvil con HTTP de Supabase simulado: dos participantes, login de moderación, todas las fases, campos opcionales con placeholders, etiquetas arrastrables, selección múltiple y sin áreas, edición/eliminación, límite de 10 ideas, privacidad visual, cambios de clasificación, recarga, CSV, errores/reintentos y denegación de un moderador sin permisos. También verifica resultados con más de 1.000 filas y que el reinicio invalide el mural conservado. No prueba el servicio remoto ni una conexión Realtime real. En Windows usa Edge instalado. En otros sistemas instalá Chromium con `npx playwright install chromium`; opcionalmente establecé `PLAYWRIGHT_EXECUTABLE_PATH`. Capturas y trazas se guardan en `test-results/` y se ignoran en Git. El servidor de prueba usa variables ficticias, puerto 5199 y no cambia `.env.local`.

Después de configurar Supabase, hacé una prueba real: un navegador para moderación y dos perfiles independientes para participantes. Confirmá que una recarga conserve el nombre y los datos, que la otra persona no vea tus ideas durante escritura, que ambos vean el mural en clasificación y que los resultados reflejen sus elecciones. Para validar permisos, usá tokens de participante a través de la API (el SQL Editor como `postgres` omite RLS y no representa un participante). Todavía deben verificarse en tu proyecto Auth, la Data API y Realtime, porque el SQL y la configuración se aplican manualmente.

## Publicación

Esta es una SPA estática: Supabase es el backend y no se necesita servidor Node en producción.

1. Subí el repositorio al proveedor de hosting elegido, sin `.env.local`.
2. Configurá **`VITE_SUPABASE_URL`** y **`VITE_SUPABASE_PUBLISHABLE_KEY`** como variables del build, con los mismos valores públicos que en local.
3. Usá **`npm ci`**, comando de build **`npm run build`** y carpeta de publicación **`dist`**. En Netlify, Vercel o Cloudflare Pages podés seleccionar el preset Vite. El flujo usa la raíz y query strings, sin rutas que necesiten reescritura.
4. Publicá por HTTPS, actualizá la Site URL en Supabase y compartí el enlace definitivo. El almacenamiento de sesión pertenece al origen: no cambies de dominio durante el encuentro.
5. Si servís desde una subcarpeta, configurá `base` en `vite.config.ts` y reconstruí; usá la URL de esa subcarpeta, con `?moderador` para el equipo.

No se aplicó SQL a tu Supabase ni se publicó el sitio automáticamente. El frontend no incluye claves secretas ni `service_role`.
