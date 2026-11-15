# Hetzner Cloud (Plataforma › Infraestructura)

El gestor de infraestructura (ADR 050) crea y administra servidores en Hetzner
Cloud con su API oficial. **Nada que genere costo se crea sin una solicitud y una
aprobación explícita** dentro del presupuesto que fijes, y ningún asistente de IA
puede crear, apagar ni eliminar servidores.

El token **nunca** se pega en el chat, en el código ni en archivos: se escribe una
sola vez en el formulario, se prueba con Hetzner, se guarda cifrado y después solo
se ven sus últimos 4 caracteres.

## 1. Crear el token (en Hetzner)

1. Entra a la consola de Hetzner Cloud y crea un **proyecto dedicado** a los
   servidores de clientes (no mezcles con otros servidores tuyos: el token da
   acceso a todo el proyecto).
2. En ese proyecto: **Security → API tokens → Generate API token**.
3. Permiso **Read & Write** (con solo lectura se puede ver el catálogo y los
   servidores, pero crear falla con `PROVIDER_FORBIDDEN`).
4. Copia el token: Hetzner lo muestra una sola vez.

Hetzner no ofrece por API la lista de proyectos ni la facturación: el token
pertenece a un proyecto, y los costos que ve el panel son **estimaciones** con el
precio por hora de cada tamaño (la factura real está en la consola de Hetzner).

## 2. Conectarlo (en la plataforma)

1. Plataforma › Infraestructura › **Agregar proveedor** → Hetzner Cloud.
2. Pega el token, un nombre y los límites:
   - **Presupuesto mensual** (sin impuestos, en la moneda de Hetzner): obligatorio para aprobar servidores.
   - Máximo de servidores, regiones y tamaños permitidos (vacío = todos).
   - Imagen (por defecto `ubuntu-24.04`).
   - **Direcciones con acceso SSH (CIDR)** (p. ej. tu IP fija `203.0.113.10/32`).
     Sin redes, el puerto 22 queda cerrado en el firewall.
3. Se prueba antes de guardar: un token rechazado no se guarda.

## 3. Claves SSH

En la pestaña **Claves SSH** agrega tu clave **pública** (el contenido de
`~/.ssh/id_ed25519.pub`). Las claves privadas se rechazan. Los servidores se
crean sin contraseña de root, así que sin una clave activa no se aprueba ninguno.

## 4. Pedir y aprobar un servidor

1. **Solicitudes › Pedir servidor**: proveedor, orden de instalación (si es para un
   cliente que ya pagó), propósito, nombre, región y tamaño con su precio.
2. **Aprobar y crear**: escribe el nombre del servidor y marca «Autorizo este gasto
   mensual estimado». Se vuelven a comprobar presupuesto y límites, se registran
   las claves SSH, se crea un firewall propio (80/443 abiertos, 22 solo desde tus
   redes) y el servidor.
3. Si Hetzner responde con error, la solicitud queda «Falló» con el paso y el motivo.

Eliminar un servidor exige escribir su nombre y un motivo; queda en el historial.

## Pruebas sin costo

En desarrollo, `HETZNER_API_BASE_URL=http://127.0.0.1:4996/v1` apunta a un servidor
local (`apps/api/test/fake-hetzner.ts`) con los formatos del SDK oficial
`hetznercloud/hcloud-go`. En producción esa variable no se puede cambiar.

## 5. Instalaciones automáticas (ADR 051)

Plataforma › **Instalaciones automáticas** instala un cliente con servidor propio
(modalidad dedicada o personalizada) a partir de su orden de instalación pagada.

Antes de la primera, en el servidor de la plataforma:

1. Genera las imágenes de la versión: `./infrastructure/scripts/export-images.sh`
   (quedan en `./dist-entregas` con su `.sha256`).
2. En `.env.production` define `PROVISIONING_IMAGES_DIR=/srv/imagenes` (Docker
   monta `./dist-entregas` ahí, solo lectura) y reinicia la API.

Para cada cliente:

1. **Nueva instalación**: orden pagada, proveedor, región y tamaño (mínimo 4 GB),
   dominio del cliente, correo del administrador y el SMTP del cliente. La
   contraseña SMTP se guarda cifrada, viaja una sola vez al servidor y se borra al
   terminar.
2. La plataforma confirma el pago, prepara la entrega de la empresa (debe estar
   convertida en cliente) y **pide el servidor**: apruébalo en Infraestructura ›
   Solicitudes, como cualquier otro.
3. Con el servidor encendido, la pantalla muestra la IP: **crea el registro DNS A**
   del dominio hacia esa IP. El servidor espera hasta 3 horas.
4. El servidor se instala solo (Docker, aplicación, migraciones, HTTPS, empresa,
   respaldo diario y salud cada 5 minutos) e informa cada paso. Después la
   plataforma comprueba desde afuera el DNS, el HTTPS y el panel, y envía el
   correo de entrega al administrador (crea su contraseña con «¿Olvidaste tu
   contraseña?»).

Si algo falla, la instalación queda en «Requiere intervención» o «Error» con lo
que pasó y qué hacer, y llega un correo a los administradores. El registro del
servidor está en `/var/log/aisa-instalacion.log`; tras corregir, ejecuta
`sudo /opt/aisa/agente.sh` y pulsa **Reintentar**. Cancelar pide un motivo y, si
ya hay servidor, decide si eliminarlo (escribiendo su nombre) o dejarlo.
