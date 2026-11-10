# Licencias de componentes de terceros

Revisado el 2026-11-10 sobre los archivos LICENSE de cada repositorio oficial.
Este documento es un análisis técnico, **no asesoramiento legal**.

| Proyecto | Versión | Licencia | Qué implica para AI Sales Assistant |
|---|---|---|---|
| [Evolution API](https://github.com/EvolutionAPI/evolution-api) | 2.3.7 | Apache 2.0 + condiciones | Uso comercial permitido. Si se usa en un sistema (incluso cerrado) hay que **mostrar un aviso visible** de que se utiliza Evolution API, accesible a administradores (Configuración/Documentación). No quitar logos de su consola. |
| [n8n](https://github.com/n8n-io/n8n) | 3.2.0 | Sustainable Use License (fair-code) | Permitido como capa interna "detrás" del producto si **solo nuestro backend** habla con n8n y los clientes **no** acceden a la UI ni crean/editan flujos (FAQ oficial de licencia). Ficheros `.ee.` requieren licencia Enterprise. Prohibido revender n8n o hacer *white-label*. |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 4.19.1 | MIT (salvo `enterprise/`) | Uso comercial libre. Las funciones de `enterprise/` requieren su licencia propia; no se usan. |
| [Dify](https://github.com/langgenius/dify) | 1.19.0 | Apache 2.0 modificada | Uso comercial permitido, **salvo** operar un entorno multi-tenant (1 tenant = 1 workspace) sin autorización escrita, y no quitar logo/copyright del frontend de Dify. Diseño: un único workspace operado por nosotros, sin acceso de clientes. **Confirmar con LangGenius antes de comercializar.** |

Dependencias npm propias: se auditan en cada fase (`pnpm licenses list`,
`pnpm audit`) y solo se aceptan licencias permisivas (MIT, Apache-2.0, BSD, ISC).
