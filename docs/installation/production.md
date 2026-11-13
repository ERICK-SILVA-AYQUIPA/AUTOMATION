# Puesta en producción

Probado de punta a punta en local con el mismo `docker-compose.prod.yml`: certificado de
Caddy, registro y verificación por correo, catálogo, pedidos, inventario, invitaciones y
panel de plataforma por HTTPS (21 de los 22 pasos de `e2e/smoke.mjs`; el paso restante
falló por la resolución del dominio de prueba en el script y se comprobó a mano con
`curl`), más las rutas bloqueadas del proxy. Lo que **no** se puede probar sin tus datos:
un dominio real con Let's Encrypt, tu SMTP y tus credenciales de Meta.

## 1. Lo que necesitas

| Qué | Para qué | Recomendación |
|---|---|---|
| Servidor Linux con Docker 24+ y Compose v2 | Todo el sistema | 2 vCPU y 4 GB de RAM sin Chatwoot; 4 vCPU y 8 GB con Chatwoot. Ubuntu 24.04 LTS |
| Dominio | Panel, API y webhooks de Meta (exigen HTTPS público) | Registro **A** de `ventas.tu-dominio.com` a la IP del servidor |
| SMTP | Verificación de correo, invitaciones, recuperación de contraseña, avisos | Amazon SES, Brevo, Mailgun o Postmark, con SPF y DKIM del dominio |
| Clave de Gemini (plan de pago) | Asistente IA | Google AI Studio o Vertex AI |
| App de Meta con WhatsApp | Cada empresa conecta su número en Integraciones | Ver `docs/integrations/whatsapp-cloud-api.md` |

## 2. Preparar el servidor

```bash
# Cortafuegos: solo SSH y web
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
# Docker oficial: https://docs.docker.com/engine/install/ubuntu/
git clone https://github.com/ERICK-SILVA-AYQUIPA/AUTOMATION.git /opt/aisa && cd /opt/aisa
```

Docker publica puertos saltándose `ufw`. Por eso `docker-compose.prod.yml` solo publica
80/443 (Caddy) a internet; n8n (5678) y Chatwoot (3100) escuchan únicamente en 127.0.0.1.

## 3. Configurar y desplegar

```bash
./infrastructure/scripts/deploy.sh --init      # crea .env.production con secretos aleatorios (permisos 600)
nano .env.production                           # APP_DOMAIN, ACME_EMAIL, SMTP_*, MAIL_FROM, PLATFORM_ADMIN_EMAIL, GEMINI_API_KEY, BILLING_CONTACT
./infrastructure/scripts/deploy.sh             # construye, migra, siembra planes y arranca
```

`deploy.sh` se niega a continuar si quedan valores de ejemplo. La API tampoco arranca en
producción con URLs `http`, CORS hacia localhost, sin SMTP o con la Graph API cambiada
(comprobación de `apps/api/src/config/env.ts`).

Qué levanta: PostgreSQL 17, Redis, `migrate` (migraciones y datos base; termina y sale),
`api`, `worker`, `web` y `caddy` (HTTPS automático con Let's Encrypt, HSTS).

La contraseña del administrador general está en `PLATFORM_ADMIN_PASSWORD` de
`.env.production`. Entra en `https://APP_DOMAIN/login` y cámbiala.

### Cobrar a las empresas (manual)

Cada empresa nueva tiene `TRIAL_DAYS` (14) días de prueba. Al vencer, su cuenta queda en
**solo lectura**: ve sus datos y sigue recibiendo mensajes, pero no puede crear, modificar
ni responder. Cuando te pague por Yape o transferencia, entra en `/plataforma`, pulsa
**Cobro** en esa empresa y registra el pago (plan, meses, importe y n.º de operación): la
cuenta se activa al instante. Un plan pagado que vence tiene `BILLING_GRACE_DAYS` (3) días
de gracia. Pon en `BILLING_CONTACT` cómo pagarte (p. ej. `"Yape 999 999 999 a nombre de ..."`);
se muestra a las empresas en el aviso de vencimiento.

## 4. Qué queda publicado

| Ruta | Destino |
|---|---|
| `https://APP_DOMAIN/api/*` | API (incluye webhooks de Meta y Chatwoot, con el cuerpo intacto para validar firmas) |
| `https://APP_DOMAIN/api/v1/internal/*` | **404 siempre** (API solo para n8n; sin distinguir mayúsculas) |
| `https://APP_DOMAIN/*` | Panel web |
| `http://*` | Redirección a HTTPS |

PostgreSQL y Redis no tienen puerto en el host. La API solo acepta la IP real del cliente
si la manda Caddy (`TRUST_PROXY` = red interna 172.30.0.0/24).

## 5. Opcionales

**Automatizaciones (n8n).** En `.env.production`: `COMPOSE_PROFILES=automation` y
`N8N_WEBHOOK_BASE_URL=http://n8n:5678/webhook`. Despliega otra vez y luego importa los
flujos y la credencial con `services/n8n/setup.sh`. Para abrir la interfaz de n8n:
`ssh -L 5678:127.0.0.1:5678 usuario@servidor` y `http://localhost:5678`.

**Bandeja de agentes (Chatwoot).**
1. Crea el registro DNS de un segundo dominio (p. ej. `chat.tu-dominio.com`) y ponlo en `CHATWOOT_DOMAIN`.
2. Ejecuta `COMPOSE_PROFILES=chatwoot` y `cp infrastructure/caddy/extra/chatwoot.caddy.example infrastructure/caddy/extra/chatwoot.caddy`.
3. Ejecuta `./infrastructure/scripts/deploy.sh`.
4. Ejecuta `docker compose -f docker-compose.prod.yml --env-file .env.production exec chatwoot-rails bundle exec rails db:chatwoot_prepare`.
5. Cierra el asistente de instalación y crea el token: `PROD=1 bash services/chatwoot/setup-platform.sh` (lo guarda en `.env.production`); vuelve a ejecutar `deploy.sh` para que la API lo lea.

`/super_admin` e `/installation` responden 404 desde internet. Para entrar, usa un túnel
SSH a `127.0.0.1:3100`.

## 6. Copias de seguridad

```bash
sudo mkdir -p /var/backups/aisa
# cron diario a las 03:15, conserva 14 días
15 3 * * * cd /opt/aisa && PROD=1 ./infrastructure/scripts/backup.sh /var/backups/aisa >> /var/log/aisa-backup.log 2>&1
```

Copia `/var/backups/aisa` **fuera del servidor**, por ejemplo con `rclone` a un
almacenamiento S3. Guarda `.env.production` en un gestor de secretos: sin
`DATA_ENCRYPTION_KEY` hay que volver a introducir las credenciales de WhatsApp de cada
empresa. Restaurar: `PROD=1 ./infrastructure/scripts/restore.sh <archivo.dump> ai_sales`.

## 7. Actualizar

```bash
cd /opt/aisa && git pull && ./infrastructure/scripts/deploy.sh
```

`deploy.sh` (ADR 045) lee la versión en marcha, hace un **respaldo completo antes de
tocar nada** (`BACKUP_DIR`, por defecto `./backups`; si falla, no actualiza), construye,
aplica las migraciones (servicio `migrate`; la API no arranca si fallan), comprueba la
salud de la API nueva y **registra la actualización** (versión anterior y nueva,
migraciones aplicadas y respaldo) en `/plataforma` → «Sistema y versiones».

Si algo falla, indica dónde está el respaldo. Para volver atrás: `git checkout <versión
anterior>`, `./infrastructure/scripts/deploy.sh` y, si la migración llegó a cambiar datos,
`CONFIRMAR=ai_sales PROD=1 ./infrastructure/scripts/restore.sh <respaldo>/ai_sales.dump ai_sales`.

Las personalizaciones de cada empresa (reglas, asistente, automatizaciones, plantillas)
viven en la base de datos: una actualización nunca las reemplaza. Las versiones nuevas
del catálogo de automatizaciones o de una plantilla se muestran como cambios
disponibles y solo se aplican cuando la empresa (o la plataforma) lo autoriza.

## 8. Instalaciones independientes de clientes (paquete de entrega)

Para un cliente con **instancia dedicada** o **a medida** (ADR 044):

1. En `/plataforma`, ficha de la empresa → «Entrega del sistema»: nombre del sistema, dominio del cliente y contacto de soporte → «Preparar entrega». Revisa requisitos e integraciones pendientes y pulsa «Generar paquete» (ZIP reproducible, con su huella SHA-256).
2. En la máquina donde construyes: `./infrastructure/scripts/export-images.sh` → `dist-entregas/aisa-imagenes-<versión>.tar.gz` (+ `.sha256`). La versión debe ser la misma del paquete.
3. En el servidor del cliente: descomprime el ZIP, copia el archivo de imágenes dentro de `instalacion/` y sigue `docs/instalacion.md` del paquete (`./instalar.sh --verificar`, `./instalar.sh`).

**Actualizar una instalación independiente**: prepara una entrega nueva de la empresa
(con la versión actual), descarga el paquete y las imágenes, y en el servidor del cliente,
desde la carpeta `instalacion/` del paquete nuevo:
`./actualizar.sh /opt/<dominio>/instalacion --verificar` y luego sin `--verificar`.
Respalda todo antes, no pisa archivos personalizados ni `.env.production`, migra,
comprueba la salud, registra el resultado y, si algo falla, vuelve solo a la versión
anterior con sus datos. La pestaña «Sistema y versiones» lista las instalaciones
entregadas con una versión anterior. Detalle en `docs/instalacion.md` del paquete.

Para una prueba en una máquina con poco disco se puede bajar el mínimo de 20 GB con `INSTALAR_DISCO_MINIMO_GB=5 ./instalar.sh` (queda como aviso en el registro); en producción no se usa.

El paquete no lleva contraseñas ni claves: el instalador genera los secretos en el servidor y las credenciales de WhatsApp e IA se configuran allí.

## 9. Lista de comprobación antes de vender

- [ ] DNS y HTTPS: `https://APP_DOMAIN` abre con candado válido.
- [ ] SMTP: el registro de una empresa de prueba recibe el correo de verificación (revisa spam, SPF y DKIM).
- [ ] Contraseña del administrador general cambiada.
- [ ] Copia de seguridad diaria programada y una restauración probada.
- [ ] WhatsApp: número real conectado, webhook verificado en Meta y un mensaje de ida y vuelta.
- [ ] Gemini con plan de pago (en el gratuito Google puede usar los mensajes).
- [ ] Textos legales publicados: términos del servicio y política de privacidad (tratamiento de datos de los clientes finales de cada empresa; en Perú, Ley 29733).
- [ ] Monitoreo: un servicio externo que consulte `https://APP_DOMAIN/api/v1/health/ready` cada minuto (UptimeRobot, Better Stack…).
