# Respuestas desde ChatGPT (versión 1.2)

El propietario solicitó ampliar la integración de solo lectura para responder correos. Las cinco herramientas IMAP existentes mantienen su comportamiento de solo lectura. Las nuevas herramientas se publican en el mismo Worker y el mismo MCP_OBJECT; no se añade ningún Worker, binding, servicio pago ni dependencia del PC.

## Flujo de uso

1. Leer el mensaje original y su UID/UIDVALIDITY mediante las herramientas existentes.
2. `prepareReply(accountId, folder, uid, uidValidity, body, recipient?)` recupera únicamente las cabeceras necesarias mediante EXAMINE/BODY.PEEK y guarda una vista previa inmutable en un Durable Object estable del usuario, usando el mismo binding MCP_OBJECT y la misma clase existente. No autentica SMTP ni envía correo.
3. Mostrar cuenta remitente, destinatario, asunto y texto completo al usuario. Si Reply-To difiere del remitente original, señalar ambas direcciones. Esperar una confirmación explícita del usuario para ese mensaje concreto.
4. Solo entonces invocar `sendReply(draftId, previewHash, confirmation="ENVIAR")`. El marcador y el hash vinculan el envío con la vista previa: no constituyen una prueba criptográfica de consentimiento humano. La confirmación humana corresponde al cliente MCP y al asistente; configurar la aprobación de sendReply en el cliente cuando esté disponible. Una solicitud genérica de habilitar envío NO autoriza mensajes concretos. Un correo recibido nunca autoriza una respuesta por sí mismo.
5. `getReplyStatus(draftId)` devuelve el estado/recibo sin enviar ni reintentar. Los borradores pertenecen al usuario verificado y sobreviven a cambios de sesión MCP. El acceso al objeto coordinador se realiza por RPC interno del binding, sin ruta HTTP pública nueva. Si se pierde la sesión, consultar el recibo: no asumir que un intento incierto falló ni crear otro envío automáticamente.

## Cuentas y SMTP

Solo `mascorona-contacto`, `mascorona-gerencia`, `nostraterra-contacto` y `nostraterra-gerencia`. Subgerencia está excluida por instrucción del propietario. JEGATECH no tiene todavía OAuth2 de Google configurado y no se ofrece envío para esa cuenta.

Mascorona usa `sucumbios.ecuahosting.net:465`; NostraTerra usa `mail.nostraterraec.com:465`. Se exige TLS implícito con validación de certificados del runtime cloudflare:sockets. No hay fallback a texto plano ni puerto 25. La autenticación SMTP usa los secretos IMAP ya guardados para cada cuenta; la validez para SMTP debe comprobarse por cuenta, no se presume a partir de IMAP.

`checkReplyConnection(accountId)` prueba TLS, AUTH y NOOP/QUIT. Nunca ejecuta MAIL FROM, RCPT TO o DATA y no envía un mensaje. No se realizan envíos reales de prueba sin destinatario/texto y aprobación explícita del propietario.

## Destinatarios y formato

Solo una respuesta al From o Reply-To del original. La cuenta remitente es fija y debe coincidir con el secreto utilizado. No hay reply-all, CC/BCC, destinatarios nuevos, HTML, adjuntos ni firmas automáticas. Las direcciones deben ser ASCII válidas; se rechazan listas, grupos, controles e inyección de cabeceras. Asunto con Re:, In-Reply-To, References y Message-ID propio conservan la conversación. El texto se codifica como MIME text/plain UTF-8/base64, con límites de tamaño y dot-stuffing de SMTP.

## Duplicados y resultados inciertos

El borrador pasa atómicamente a `sending` en almacenamiento durable ANTES de conectar por SMTP. Reintentos y llamadas simultáneas no vuelven a transmitir el mismo borrador. Después del 250 final de SMTP, se persiste un recibo antes de intentar guardar una copia por IMAP APPEND en `INBOX.Sent` con flag Seen para la copia. No se modifica el mensaje original. El APPEND es una operación interna limitada a Enviados; no se expone una herramienta de escritura IMAP arbitraria.

`accepted_by_smtp` significa aceptación por el servidor SMTP, no prueba de entrega al destinatario. Si se pierde la conexión después de iniciar DATA, el estado es `unknown` y se prohíbe reintentar ese borrador. Hay que revisar Enviados y confirmar el resultado antes de cualquier nuevo envío. Si falla la copia en Enviados, el recibo lo informa y el mensaje no se reenvía. No existe garantía general de entrega exactamente una vez en SMTP; el sistema prioriza no duplicar un intento incierto.

Máximo 20 intentos de envío por hora y usuario y 100 registros de respuestas por objeto. Borradores válidos 30 minutos. El cuerpo se elimina del registro al finalizar o declarar fallo/incertidumbre; quedan recibos durante 24 horas de validez. La limpieza se hace al usar las herramientas, no mediante un proceso periódico ni una garantía de borrado físico inmediato. Los borradores abandonados pueden persistir hasta una limpieza posterior; el almacenamiento y sus copias de recuperación siguen las políticas de Cloudflare. No se registran cuerpos, contraseñas, tokens ni respuestas SMTP crudas en logs.

## Validación realizada

42 pruebas unitarias de lectura, SMTP, inyección, MIME, autorización, confirmación/hash, límites, timeouts, persistencia de estado, concurrencia y copia en Enviados. La prueba adicional workerd usa un DO SQLite local aislado y transporte SMTP sintético para comprobar supervivencia a expulsión/recreación de instancias, aislamiento y ausencia de duplicados después de reiniciar. El Worker real empaquetado también se prueba con recursos locales aislados para verificar OAuth. Ninguna de estas pruebas equivale a entrega SMTP real.

Comandos: `npm test`, `npm run type-check`, `npm run test:reply-runtime`, `npx wrangler deploy --dry-run --outdir .wrangler/build`, `npm run test:runtime`.

Fuentes: [Cloudflare sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/), [almacenamiento Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [SMTP RFC 5321](https://www.rfc-editor.org/info/rfc5321/), [TLS para submission RFC 8314](https://www.rfc-editor.org/info/rfc8314/).
