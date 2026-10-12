# Repository Guidelines

Aplicación participativa del CEIDEF con Vite, React, TypeScript y Supabase. La interfaz está en español; no integra modelos de IA.

## Estructura y organización

- `src/App.tsx`: vistas de participantes y moderación; `src/components/`: formularios y etiquetas de áreas.
- `src/hooks/useWorkshop.ts`: carga y sincronización; `src/lib/`: cliente Supabase, API, reglas compartidas, CSV y paginación.
- `src/App.css` y `src/index.css`: estilos; `public/` y `src/assets/`: recursos gráficos.
- `supabase/setup.sql`: instalación inicial; `supabase/migrations/`: actualizaciones; `supabase/reset.sql`: reinicio.
- `tests/*.test.mjs`: pruebas locales; `tests/browser/`: flujo de navegador; `tests/fixtures/`: esquemas históricos para migraciones.

## Comandos de desarrollo

Usá Node.js 24 o posterior. Si PowerShell bloquea `npm.ps1`, ejecutá `npm.cmd`.

| Comando | Función |
| --- | --- |
| `npm ci` | Instala las dependencias del lockfile. |
| `npm run dev` | Inicia Vite localmente. |
| `npm run build` | Verifica TypeScript y genera `dist/`. |
| `npm run preview` | Sirve la compilación local. |
| `npm run lint` | Ejecuta ESLint. |
| `npm test` | Verifica SQL, migraciones, CSV y paginación. |
| `npm run test:e2e` | Ejecuta Playwright en escritorio y móvil. |

## Estilo y convenciones

Seguí el estilo existente: dos espacios, comillas simples y sin punto y coma en TypeScript. Usá componentes en PascalCase, funciones y variables en camelCase, hooks `useNombre` y nombres SQL en snake_case. Preferí `import type` para tipos. ESLint valida TypeScript y hooks; no hay Prettier configurado. Reutilizá variables CSS y conservá la legibilidad y adaptación móvil.

## Pruebas

Las pruebas usan `node:test`, PGlite y Playwright. Nombrá archivos `*.test.mjs` o `*.spec.mjs`, respectivamente. No existe un umbral de cobertura. Agregá regresiones relevantes para permisos, fases, clasificaciones y conservación de datos; mantené intactos los fixtures históricos. Playwright simula Supabase y usa el puerto 5199; esas pruebas no verifican el servidor remoto. Antes de entregar cambios funcionales, ejecutá pruebas, lint y build.

## Commits y pull requests

El historial es breve (`Initial commit`, `Feat: iteracion 1`). Usá títulos descriptivos como `Fix: conservar selecciones`. Las PR deben explicar cambios y validación, vincular incidencias pertinentes y adjuntar capturas para cambios visuales. Documentá migraciones y efectos sobre datos existentes.

## Seguridad y cambios de datos

Configurá `.env.local` siguiendo `.env.example`; nunca publiques secretos ni `service_role`. Las variables `VITE_*` son públicas. Conservá RLS y validaciones de fase en SQL. Actualizá `setup.sql` y agregá una migración para cambios de esquema; documentá su orden en `README.md`. El reinicio debe preservar las ideas predeterminadas.
