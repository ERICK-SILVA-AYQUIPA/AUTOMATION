import { FEATURE_NAME, MODE_NAME, MODULE_NAME, type DeliveryManifest } from './manifest.js';

/**
 * Documentación del paquete de entrega (ADR 044), generada a partir del
 * manifiesto: solo describe lo que el cliente contrató y lo que existe en el
 * sistema. Las mismas entradas producen siempre el mismo texto (sin fechas
 * de generación), así el paquete es reproducible.
 */
const yes = (b: boolean) => (b ? 'Sí' : 'No');
const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
const has = (m: DeliveryManifest, mod: string) => (m.modules as string[]).includes(mod);
const own = (m: DeliveryManifest) => m.system.deploymentMode !== 'SAAS';
const day = (iso: string) => iso.slice(0, 10);

function settingsLines(m: DeliveryManifest): string[] {
  const s = m.configuration.settings as {
    catalog?: { label?: string; trackStockDefault?: boolean; volumePricing?: boolean; durations?: boolean };
    orders?: { minAmount?: number | null };
    customers?: { businessFields?: boolean };
    reservations?: { kind?: string; capacity?: number | null; hours?: unknown; slotMinutes?: number; durationMinutes?: number; requireConfirmation?: boolean };
  };
  const out = [
    `Nombre del catálogo en el menú: ${s.catalog?.label ?? 'Productos'}`,
    `Productos nuevos con control de stock: ${yes(!!s.catalog?.trackStockDefault)}`,
    `Precios por volumen: ${yes(!!s.catalog?.volumePricing)}`,
  ];
  if (has(m, 'orders')) out.push(`Pedido mínimo: ${s.orders?.minAmount != null ? `${m.client.currency} ${s.orders.minAmount.toFixed(2)}` : 'sin mínimo'}`);
  if (has(m, 'customers')) out.push(`Clientes comerciales (razón social): ${yes(!!s.customers?.businessFields)}`);
  if (has(m, 'reservations')) {
    const r = s.reservations ?? {};
    out.push(
      `Reservas: ${r.kind === 'APPOINTMENT' ? 'citas' : 'mesas'}, cada ${r.slotMinutes ?? 30} min, duración ${r.durationMinutes ?? 0} min`,
      `Capacidad de reservas: ${r.capacity ?? 'SIN CONFIGURAR (no se aceptan reservas hasta definirla)'}`,
      `Horario de reservas: ${r.hours ? 'configurado' : 'SIN CONFIGURAR (no se aceptan reservas hasta definirlo)'}`,
      `Reservas del asistente quedan por confirmar: ${yes(r.requireConfirmation !== false)}`,
    );
  }
  return out;
}

function readme(m: DeliveryManifest): string {
  const pending = m.integrations.filter((i) => i.pending);
  return `# ${m.system.name}

Paquete de entrega n.º ${m.number} para **${m.client.name}**${m.client.legalName ? ` (${m.client.legalName})` : ''}.
Versión de la aplicación: **${m.appVersion}** · Preparado el ${day(m.preparedAt)}.

| | |
|---|---|
| Modalidad contratada | ${MODE_NAME[m.system.deploymentMode]} |
| Dirección del panel | ${m.system.panelUrl} |
| Plan | ${m.plan.name} |
| Moneda y zona horaria | ${m.client.currency} · ${m.client.timezone} |
${m.template ? `| Plantilla del sector | ${m.template.key} (versión ${m.template.version ?? '—'}) |\n` : ''}
## Módulos habilitados

${list(m.modules.map((k) => MODULE_NAME[k] ?? k))}

## Funciones contratadas

${list([
  `Hasta ${m.plan.limits.maxUsers} usuarios`,
  `Hasta ${m.plan.limits.maxWhatsappNumbers} número(s) de WhatsApp`,
  `Hasta ${m.plan.limits.maxConversationsPerMonth} conversaciones al mes`,
  `Hasta ${m.plan.limits.maxProducts} productos`,
  `Hasta ${m.plan.limits.maxBranches} sucursal(es)`,
  ...(m.plan.limits.maxAiTokensPerMonth ? [`Tope de IA: ${m.plan.limits.maxAiTokensPerMonth} tokens al mes`] : []),
  ...m.plan.limits.features.map((f) => FEATURE_NAME[f] ?? f),
])}

## Configuración

${list(settingsLines(m))}

## Requisitos

| Requisito | Obligatorio | Detalle |
|---|---|---|
${m.requirements.map((r) => `| ${r.label} | ${yes(r.required)} | ${r.detail} |`).join('\n')}

## Integraciones pendientes

${pending.length ? `| Integración | Estado | Qué falta |\n|---|---|---|\n${pending.map((i) => `| ${i.name} | ${i.status} | ${i.detail}. ${i.howTo} |`).join('\n')}` : 'Ninguna: todas las integraciones necesarias están verificadas.'}

## Datos de acceso iniciales

Panel: ${m.initialAccess.panelUrl}

${m.initialAccess.admins.length ? list(m.initialAccess.admins.map((a) => `${a.name} · ${a.email} · ${a.status}`)) : '- Sin administradores registrados'}

Este paquete **no contiene contraseñas ni claves**. Cada administrador crea su contraseña desde el enlace de invitación que recibe por correo.

## Instrucciones

${own(m)
  ? `1. Revisa los requisitos de arriba y la guía [docs/instalacion.md](docs/instalacion.md).
2. Copia la carpeta \`instalacion/\` al servidor junto con el archivo de imágenes \`aisa-imagenes-${m.appVersion}.tar.gz\`.
3. Ejecuta \`./instalar.sh --verificar\`: comprueba los requisitos sin tocar nada.
4. Ejecuta \`./instalar.sh\`: genera los secretos, instala, comprueba la salud y carga la configuración de esta empresa.
5. Conecta WhatsApp y la IA con las guías de \`docs/\`.`
  : `1. El administrador abre el correo de invitación y crea su contraseña.
2. Sigue la lista «Puesta en marcha» del inicio del panel.
3. Conecta WhatsApp con [docs/guia-whatsapp.md](docs/guia-whatsapp.md) y configura el asistente con [docs/guia-ia.md](docs/guia-ia.md).`}

## Contenido del paquete

- \`entrega.json\`: los datos de esta entrega en formato legible por máquina (sin secretos).
- \`docs/\`: manual de usuario, manual de administración, guía de WhatsApp, guía de IA y procedimiento de soporte${own(m) ? ', y guía de instalación' : ''}.
${own(m) ? '- `instalacion/`: Docker Compose, variables de entorno de ejemplo, Caddy (dominio y HTTPS), instalador, salud, respaldo, restauración y registros.\n' : ''}- \`SHA256SUMS\`: huella de cada archivo para comprobar que nada se modificó (\`sha256sum -c SHA256SUMS\`).

## Soporte

${m.support.contact}${m.support.notes ? `\n\n${m.support.notes}` : ''}
`;
}

function userManual(m: DeliveryManifest): string {
  const s = m.configuration.settings as { catalog?: { label?: string } };
  const catalog = s.catalog?.label ?? 'Productos';
  const sections: string[] = [`# Manual de usuario · ${m.system.name}

Este manual explica el trabajo diario en el panel (${m.system.panelUrl}). Cada persona entra con su correo y su contraseña; lo que ve depende de su rol.

## Entrar

1. Abre ${m.system.panelUrl} y escribe tu correo y tu contraseña.
2. Si la olvidaste, usa «¿Olvidaste tu contraseña?»: recibirás un enlace por correo.
3. Para salir, usa el botón de salida arriba a la derecha. En Configuración puedes cerrar tus sesiones en otros dispositivos.

## Inicio

Resume ventas, pedidos, conversaciones y avisos. La campana muestra los avisos internos (pedidos nuevos, derivaciones, stock bajo, errores).`];
  if (has(m, 'conversations')) sections.push(`## Conversaciones

- Cada mensaje de WhatsApp llega a «Conversaciones». ${has(m, 'ai') ? 'El asistente IA responde solo mientras esté activo para esa conversación.' : ''}
- **Tomar una conversación**: asígnatela y responde desde el panel. Al responder tú, el asistente se pausa en esa conversación para no hablar a la vez.
- Puedes añadir etiquetas y notas internas (el cliente no las ve) y cerrar la conversación al terminar.
- Fuera de la ventana de 24 h de WhatsApp solo se pueden enviar plantillas aprobadas por Meta.`);
  if (has(m, 'catalog')) sections.push(`## ${catalog}

- Crea cada producto con nombre, código (SKU), precio y categoría. Puede tener variantes (talla, color, presentación).
- «Controla stock» está marcado para productos físicos. Desmárcalo para platos preparados o servicios: se venden mientras estén activos.
- Con precios por volumen activos, cada variante puede tener tramos: desde cierta cantidad, la unidad cuesta menos. El pedido aplica el tramo automáticamente.
- Importa o exporta el catálogo en Excel desde la misma página.
- El asistente solo ofrece lo que está activo y con el precio guardado aquí.`);
  if (has(m, 'inventory')) sections.push(`## Inventario

- Las existencias se mueven solo con operaciones registradas: entradas, ajustes, transferencias entre sucursales y ventas confirmadas.
- Cada movimiento queda en el historial con quién lo hizo. Ni el asistente ni las automatizaciones cambian el stock directamente.
- El stock mínimo de un producto genera un aviso de stock bajo.`);
  if (has(m, 'orders')) sections.push(`## Pedidos

- Los pedidos llegan de WhatsApp (los registra el asistente como **pendientes**) o se crean a mano en «Nuevo pedido».
- **Confirmar** descuenta el stock; **anular** lo devuelve. Los precios siempre los toma el sistema del catálogo.
- Si hay pedido mínimo configurado, un pedido que no llega no se puede registrar.
- Estados: pendiente → confirmado → en preparación → enviado → entregado (o anulado). Puedes exportar la lista a CSV.`);
  if (has(m, 'reservations')) sections.push(`## Reservas

- «Reservas» muestra el día elegido, los horarios libres y el cupo que queda en cada uno.
- «Nueva reserva» pide el teléfono del cliente, la fecha, la hora libre y el número de personas (o el servicio, en citas).
- Las reservas que hace el asistente por WhatsApp pueden quedar «por confirmar»: confírmalas o cancélalas desde la lista. Después márcalas como atendidas o «no asistió».
- El sistema nunca permite superar la capacidad de un horario.`);
  if (has(m, 'customers')) sections.push(`## Clientes

- Se crean solos al escribir por WhatsApp o al registrar un pedido; también puedes crearlos a mano.
- La ficha muestra sus pedidos, lo que más compra${has(m, 'reservations') ? ', sus reservas' : ''} y notas internas.`);
  if (has(m, 'reports')) sections.push(`## Reportes

Ventas por periodo, productos más vendidos, pedidos por estado y actividad de conversaciones. Se pueden filtrar por fechas.`);
  sections.push(`## Roles

- **Administrador**: todo, incluidos usuarios, integraciones y configuración.
- **Supervisor**: conversaciones (también asignarlas), pedidos, clientes y reportes; consulta catálogo, inventario y usuarios.
- **Vendedor**: conversaciones, pedidos y clientes; consulta catálogo e inventario.`);
  return `${sections.join('\n\n')}\n`;
}

function adminManual(m: DeliveryManifest): string {
  return `# Manual de administración · ${m.system.name}

Para el administrador de la empresa (rol «Administrador»).

## Puesta en marcha

En el inicio aparece la lista «Puesta en marcha» con las tareas obligatorias y recomendadas. Se calcula con datos reales: una tarea se marca hecha cuando el sistema lo comprueba (por ejemplo, el primer mensaje de WhatsApp recibido), no a mano.

## Usuarios

- «Usuarios» → «Invitar usuario»: la persona recibe un correo para crear su contraseña. Nadie más la conoce.
- Puedes cambiar el rol o desactivar a una persona; desactivarla cierra sus sesiones.
- Límite del plan: ${m.plan.limits.maxUsers} usuarios.

## Configuración

- **Empresa**: nombre comercial, razón social, RUC, contacto, logotipo, color, moneda (${m.client.currency}) y zona horaria (${m.client.timezone}).
- **Operación**: nombre del catálogo, control de stock por defecto, precios por volumen${has(m, 'orders') ? ', pedido mínimo' : ''}${has(m, 'customers') ? ', clientes comerciales' : ''}${has(m, 'reservations') ? ', y reservas (tipo, capacidad, horario semanal, intervalos, antelación y confirmación)' : ''}. Los cambios aplican también al asistente.
- **Plan**: estado, fecha de vencimiento, consumo frente a los límites y pagos registrados. El cobro es manual: no hay cargos automáticos.

Configuración actual al preparar esta entrega:

${list(settingsLines(m))}

## Integraciones

«Integraciones» muestra el estado real de cada servicio (conectado, pendiente, con error o sin configurar), su última comprobación y el botón «Probar», que hace una petición real. Ahí se conectan los números de WhatsApp, la clave propia de Gemini (opcional) y los webhooks hacia tus sistemas. Las claves se guardan cifradas y solo se muestran sus últimos caracteres.

${has(m, 'automations') ? `## Automatizaciones

Activa o desactiva cada automatización y ajusta su configuración (destinatarios, canales, importes, horas). El historial muestra cada ejecución, su resultado y permite reintentar las fallidas. Las automatizaciones nunca registran pedidos ni mueven stock: solo avisan.

Estado al preparar esta entrega:

${list(m.configuration.automations.map((a) => `${a.key}: ${a.isEnabled ? 'activa' : 'inactiva'}`))}
` : ''}
## Seguridad

- Cada empresa solo ve sus datos; la separación la hace la base de datos (seguridad por filas), no solo la aplicación.
- Las acciones importantes quedan en la auditoría (quién, qué y cuándo).
- Usa contraseñas largas y no compartas cuentas: invita a cada persona.
`;
}

function whatsappGuide(m: DeliveryManifest): string {
  return `# Guía de conexión de WhatsApp · ${m.system.name}

El sistema usa la **WhatsApp Cloud API oficial de Meta**. No usa WhatsApp Web ni aplicaciones no oficiales.

## Antes de empezar

- Una cuenta de Meta Business (business.facebook.com), idealmente verificada.
- Un número de teléfono que **no** esté en uso en la aplicación de WhatsApp (o eliminado de ella).
- Límite del plan: ${m.plan.limits.maxWhatsappNumbers} número(s).

## 1. Crear la app en Meta

1. En developers.facebook.com → «Mis apps» → «Crear app» → tipo «Empresa».
2. Añade el producto **WhatsApp** y elige tu cuenta de Meta Business.
3. En «WhatsApp → Configuración de la API» añade y verifica tu número. Anota el **Phone number ID** y, si quieres, el **WhatsApp Business Account ID**.
4. En «Configuración de la app → Básica» copia la **clave secreta de la app (App Secret)**.

## 2. Token permanente

1. En la configuración del negocio → «Usuarios del sistema» → crea un usuario del sistema administrador.
2. «Asignar activos»: la app (control total) y la cuenta de WhatsApp.
3. «Generar token» con los permisos \`whatsapp_business_messaging\` y \`whatsapp_business_management\`, sin caducidad.

El token es una credencial: pégalo solo en el panel, nunca por chat ni correo.

## 3. Conectar el número en el panel

1. Panel → «Integraciones» → «Números de WhatsApp» → «Conectar número».
2. Escribe Phone number ID, App Secret y Token de acceso → «Verificar y guardar». El sistema lo comprueba con Meta antes de guardarlo y lo guarda cifrado.
3. Se muestran la **URL de devolución de llamada (Callback URL)** y el **Token de verificación (Verify token)** de ese número.

## 4. Configurar el webhook en Meta

1. En la app de Meta → «WhatsApp → Configuración» → «Webhook» → «Editar».
2. Pega la Callback URL y el Verify token del panel → «Verificar y guardar».
3. En «Campos del webhook» suscríbete a **messages**.

## 5. Probar

1. Escribe al número desde otro teléfono: el mensaje debe aparecer en «Conversaciones» y el estado del número pasa a «Conectado».
2. En «Integraciones», el botón «Probar» comprueba las credenciales con Meta.

## Problemas frecuentes

- **El mensaje no llega**: revisa que el webhook esté suscrito a «messages» y que la URL sea exactamente la del panel.
- **Error de token**: el token caducó o no tiene los permisos; genera uno nuevo y cámbialo en «Credenciales».
- **No se pueden enviar mensajes pasado un día**: fuera de la ventana de 24 h desde el último mensaje del cliente, Meta solo permite plantillas aprobadas.
`;
}

function aiGuide(m: DeliveryManifest): string {
  const p = m.configuration.ai.profile as { assistantName?: string; tone?: string; language?: string };
  return `# Guía de configuración de IA · ${m.system.name}

El asistente responde por WhatsApp con el modelo **Gemini** de Google. Consulta el catálogo, ${has(m, 'orders') ? 'registra pedidos como pendientes, ' : ''}${has(m, 'reservations') ? 'consulta horarios y registra reservas, ' : ''}y deriva a una persona cuando hace falta. **Nunca** cambia precios ni existencias: esas operaciones solo las hace el sistema.

Configuración publicada al preparar esta entrega: asistente «${p.assistantName ?? '—'}», tono «${p.tone ?? '—'}», idioma ${p.language ?? 'es'}; ${m.configuration.knowledge.length} documento(s) de conocimiento; asistente ${m.configuration.ai.isEnabled ? 'activo' : 'desactivado'}.

## Clave de Gemini

${own(m)
  ? '- En una instalación propia la clave es del cliente: crea una en Google AI Studio (aistudio.google.com → «Get API key») con la facturación activada y ponla en `GEMINI_API_KEY` del archivo `.env.production`, o por empresa en «Integraciones → Asistente IA».'
  : '- La plataforma ya aporta una clave. Si la empresa prefiere la suya, la pega en «Integraciones → Asistente IA»: se valida con Google antes de guardarse y se guarda cifrada.'}
- En el nivel gratuito de Gemini, Google puede usar los mensajes para mejorar sus productos: para clientes reales usa una clave con facturación.

## Configurar el asistente

Panel → «Asistente IA»:

1. **Personalidad**: nombre, tono, emojis e idioma (o el del cliente).
2. **Horario** por día (hasta dos turnos) y qué hacer fuera de horario.
3. **Datos del negocio**: medios de pago, entregas, devoluciones y preguntas frecuentes.
4. **Preguntas antes de recomendar** y **palabras para derivar** a una persona.
5. **Documentos de conocimiento**: textos con información del negocio que el asistente usa para responder.
6. **Indicaciones adicionales**: no pueden anular las reglas fijas de seguridad.

Los cambios quedan en **borrador**. Usa «Probar el asistente» y después «Publicar»; publicar exige haber probado la versión actual.

## Consumo

El consumo de tokens del mes aparece en la misma página. Puedes fijar un tope propio${m.plan.limits.maxAiTokensPerMonth ? ` dentro del límite del plan (${m.plan.limits.maxAiTokensPerMonth} tokens al mes)` : ''}: al alcanzarlo el asistente deriva a una persona y avisa.
`;
}

function supportDoc(m: DeliveryManifest): string {
  return `# Procedimiento de soporte · ${m.system.name}

## Contacto

${m.support.contact}${m.support.notes ? `\n\n${m.support.notes}` : ''}

## Antes de escribir

1. Revisa «Integraciones»: el estado de cada servicio y su último error suelen explicar el problema.
2. Revisa los avisos (campana) y el historial de «Automatizaciones».
${own(m) ? '3. En el servidor, ejecuta `./salud.sh` y guarda su salida.\n' : ''}
## Qué incluir en el mensaje

- Empresa: **${m.client.name}** · paquete n.º ${m.number} · versión ${m.appVersion}.
- Qué estabas haciendo, qué esperabas y qué pasó (con la hora aproximada).
- Captura de pantalla o el texto del error.
${own(m) ? '- Salida de `./salud.sh` y, si se pide, de `./registros.sh api --since 1h` (revisa que no incluya datos personales).\n' : ''}
**Nunca envíes contraseñas, tokens ni claves** por chat o correo. Si soporte necesita revisar una integración, la configuras tú en el panel.

## Prioridades

| Prioridad | Ejemplos |
|---|---|
| Alta | El sistema no abre, no llegan mensajes de WhatsApp, no se pueden registrar pedidos |
| Media | Una automatización falla, un reporte no cuadra |
| Baja | Dudas de uso, mejoras |
`;
}

function installGuide(m: DeliveryManifest): string {
  const v = m.appVersion;
  return `# Guía de instalación · ${m.system.name}

Instalación independiente (${MODE_NAME[m.system.deploymentMode]}) en un servidor propio. Dominio: **${m.system.domain ?? '(definir)'}**.

## Requisitos

${list(m.requirements.filter((r) => r.required).map((r) => `**${r.label}**: ${r.detail}`))}

## Instalación

\`\`\`bash
# En el servidor (por ejemplo en /opt/${m.system.domain ?? 'aisa'})
unzip entrega-*.zip && cd instalacion
cp /ruta/aisa-imagenes-${v}.tar.gz .
./instalar.sh --verificar     # comprueba requisitos; no cambia nada
./instalar.sh                 # la primera vez crea .env.production con secretos aleatorios y se detiene
nano .env.production          # completa SMTP_*, ACME_EMAIL, MAIL_FROM y PLATFORM_ADMIN_EMAIL
./instalar.sh                 # verifica de nuevo, instala, comprueba la salud y carga la configuración
\`\`\`

El instalador **no continúa** si falta un requisito. Registra todo en \`instalacion-<fecha>.log\`. La configuración de la empresa (\`configuracion-cliente.json\`) se carga una sola vez: repetir la instalación no sobrescribe lo que el cliente haya personalizado.

## Dominio y HTTPS

Caddy publica solo los puertos 80 y 443 y obtiene el certificado de Let's Encrypt para \`APP_DOMAIN\` (aviso de caducidad a \`ACME_EMAIL\`). El registro DNS debe apuntar al servidor **antes** de instalar. PostgreSQL y Redis no se publican; n8n y Chatwoot solo escuchan en 127.0.0.1 (entra por túnel SSH).

## Migraciones

El servicio \`migrate\` aplica las migraciones de la base de datos de la versión instalada y termina; la API no arranca si fallan.

## Salud

\`./salud.sh\` muestra el estado de cada contenedor y comprueba \`https://<dominio>/api/v1/health/ready\` (base de datos y Redis).

## Respaldo y restauración

\`\`\`bash
./respaldo.sh /var/backups/aisa                       # volcado de cada base + archivos; borra copias de más de 14 días
15 3 * * * cd /opt/aisa/instalacion && ./respaldo.sh /var/backups/aisa   # cron diario
./restaurar.sh /var/backups/aisa/<fecha>/ai_sales.dump ai_sales          # pide confirmación
\`\`\`

Guarda **fuera del servidor** una copia de \`.env.production\`: sin \`DATA_ENCRYPTION_KEY\` hay que volver a introducir las credenciales de WhatsApp y de las integraciones.

## Registros

\`./registros.sh\` (todos) o \`./registros.sh api\`, \`worker\`, \`web\`, \`caddy\`. Los registros rotan solos (5 archivos de 20 MB por servicio).

## Actualización

Las actualizaciones se entregan como una versión nueva de imágenes. El procedimiento hace primero un respaldo, aplica las migraciones y comprueba la salud; nunca toca \`.env.production\` ni la configuración de la empresa. Ver el procedimiento de actualización que acompaña a cada versión.
`;
}

/** Archivos de documentación del paquete */
export function renderDocs(m: DeliveryManifest): { path: string; data: string }[] {
  const files = [
    { path: 'LEEME.md', data: readme(m) },
    { path: 'docs/manual-usuario.md', data: userManual(m) },
    { path: 'docs/manual-administracion.md', data: adminManual(m) },
    { path: 'docs/guia-whatsapp.md', data: whatsappGuide(m) },
    { path: 'docs/guia-ia.md', data: aiGuide(m) },
    { path: 'docs/soporte.md', data: supportDoc(m) },
  ];
  if (own(m)) files.push({ path: 'docs/instalacion.md', data: installGuide(m) });
  return files;
}
