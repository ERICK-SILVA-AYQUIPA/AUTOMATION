# API REST (apps/api)

Base: `http://localhost:4000/api/v1`. Autenticación: `Authorization: Bearer <accessToken>`
salvo las rutas marcadas como públicas. Errores con formato uniforme:

```json
{ "statusCode": 400, "message": "Datos inválidos", "code": "VALIDATION_ERROR",
  "errors": [{ "path": "email", "message": "Correo inválido" }], "requestId": "..." }
```

## Autenticación (`/auth`)

| Método | Ruta | Acceso | Descripción |
|---|---|---|---|
| POST | `/auth/register` | pública, 10/min | Registra empresa + administrador. Envía correo de verificación. |
| POST | `/auth/verify-email` | pública | `{token}` del correo (un solo uso, 24 h). |
| POST | `/auth/resend-verification` | pública | Respuesta idéntica exista o no la cuenta. |
| POST | `/auth/login` | pública, 10/min | Devuelve `accessToken` (15 min) y fija cookies `aisa_rt` (HttpOnly, path `/api/v1/auth`) y `aisa_csrf`. Bloqueo de 15 min tras 5 fallos. |
| POST | `/auth/refresh` | cookie + cabecera `X-CSRF-Token` | Rota el refresh token. Reutilizar uno viejo revoca toda la familia de sesiones. |
| POST | `/auth/logout` | cookie + `X-CSRF-Token` | Revoca la sesión. |
| GET | `/auth/me` | autenticado | Usuario, empresa, plan y lista de permisos. |
| GET | `/auth/sessions` | autenticado | Sesiones activas del usuario. |
| DELETE | `/auth/sessions/:id` | autenticado | Cierra una sesión propia. |
| POST | `/auth/forgot-password` | pública, 10/min | Envía enlace (30 min). No revela si el correo existe. |
| POST | `/auth/reset-password` | pública | `{token, password}`. Cierra todas las sesiones. |
| POST | `/auth/accept-invitation` | pública | `{token, password, name?}` para usuarios invitados. |

Contraseñas: mínimo 10 caracteres con letras y números; hash Argon2id.

## Empresa (`/tenant`) y usuarios (`/users`)

| Método | Ruta | Permiso |
|---|---|---|
| GET | `/tenant` | `tenant:read` (empresa, plan, límites y uso del periodo) |
| PATCH | `/tenant` | `tenant:settings` |
| GET | `/users`, `/users/:id` | `users:read` |
| POST | `/users` | `users:manage` (invitación por correo; respeta `maxUsers` del plan) |
| POST | `/users/:id/resend-invitation` | `users:manage` |
| PATCH | `/users/:id` | `users:manage` (nombre, rol, ACTIVE/DISABLED; desactivar revoca sesiones) |

## Plataforma (`/platform`), solo ADMINISTRADOR GENERAL

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/platform/tenants?q=&status=&page=&pageSize=` | Empresas con plan y nº de usuarios |
| PATCH | `/platform/tenants/:id/status` | `ACTIVE` / `SUSPENDED` (bloquea el acceso de inmediato) |
| PATCH | `/platform/tenants/:id/plan` | Cambio manual de plan (sin cobro) |
| GET | `/platform/metrics` | Métricas globales |

## Salud

`GET /health/live` (proceso vivo) y `GET /health/ready` (PostgreSQL y Redis), públicos.

## Matriz de permisos

Definida en `apps/api/src/common/permissions.ts` (única fuente de verdad).
