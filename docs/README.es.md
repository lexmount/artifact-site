<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/artifact-site-banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/artifact-site-banner.png">
    <img src="assets/artifact-site-banner.png" alt="artifact-site — Un hogar compartido para páginas y documentos generados por IA, en tu propio servidor. Código abierto, autoalojado, listo para agentes." width="1000">
  </picture>
</p>

<h1 align="center">artifact-site</h1>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.fr.md">Français</a> |
  <strong>Español</strong>
</p>

<p align="center">
  <a href="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml"><img src="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#licencia"><img src="https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg" alt="Licencia: Apache-2.0 OR MIT"></a>
  <a href="../.nvmrc"><img src="https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen.svg" alt="Node 24"></a>
  <a href="../ROADMAP.md"><img src="https://img.shields.io/badge/roadmap-what's%20next-8a5a2b.svg" alt="Hoja de ruta"></a>
</p>

<p align="center"><sub>Esta traducción se mantiene junto con la <a href="../README.md">versión en inglés</a>; en caso de discrepancia, prevalece el inglés.</sub></p>

Las herramientas de IA producen cada día más trabajo terminado: gráficos interactivos, informes de análisis, prototipos web y presentaciones. Ese trabajo suele acabar disperso entre historiales de chat, carpetas locales y distintas herramientas, sin un lugar común donde consultarlo, compartirlo o mantenerlo. Enseñárselo a alguien sigue implicando desplegarlo, enviar archivos o hacer una captura de pantalla; encontrar más tarde la última versión cuesta todavía más.

**artifact-site lleva ese trabajo a tu propio servidor como enlaces que puedes compartir, actualizar y buscar.** Piensa en él como un espacio de trabajo autoalojado para los artefactos de tu equipo, parecido a Claude Artifacts u OpenAI Sites: las herramientas de IA o internas que elijas crean el trabajo, y artifact-site lo publica y lo gestiona. Sube HTML, sitios estáticos o documentos para que tu equipo pueda verlos en línea, controlar el acceso y conservar revisiones. Los agentes de programación también pueden publicar, actualizar, buscar y leer el trabajo existente.

> **Pruébalo sin instalar nada:** [artifact-site.app.lexmount.com](https://artifact-site.app.lexmount.com/) ejecuta este código como servicio alojado. Suelta un archivo para publicar de forma anónima (los sitios anónimos allí caducan a los pocos días) o inicia sesión para conservar tu trabajo. Es una demo compartida: trata lo que publiques como público.

<p align="center"><img src="assets/demo.gif" alt="Un panel HTML se suelta en artifact-site: en segundos se convierte en un enlace, se muestra en un marco aislado y el panel de compartir copia el enlace" width="820"></p>
<p align="center"><sub><b>Suelta un archivo, obtén un enlace, compártelo.</b> Consulta tu trabajo publicado en línea y elige quién puede abrirlo en los ajustes de compartir.</sub></p>

## Por qué artifact-site

- **Mantén el trabajo en un solo lugar.** Organiza páginas y documentos en carpetas y encuéntralos con búsqueda de texto completo, también en chino. Los miembros del equipo y los agentes encuentran el trabajo al que tienen acceso.
- **Suéltalo y compártelo.** Sube HTML, una carpeta de build, un ZIP o un documento y obtén un enlace. Los sitios grandes se suben por partes. Comparte con todo el mundo, con usuarios registrados, con personas concretas o con quien tenga un código de acceso.
- **Sigue mejorando el trabajo publicado.** Edita el texto o el código HTML en el navegador, o deja que un agente actualice todo el sitio. Cada cambio conserva una versión, con posibilidad de revertir y de guardar una copia.
- **Deja que los agentes continúen donde lo dejaron.** Publica y actualiza mediante la guía, la CLI o MCP; después busca por contenido y lee el texto extraíble. Por ejemplo, localiza un informe anterior y actualízalo en la misma dirección para que tu equipo lo vea.

## Contenido

- [Qué puedes publicar](#qué-puedes-publicar)
- [Inicio rápido (despliegue local)](#inicio-rápido-despliegue-local)
- [Conectar un agente de programación](#conectar-un-agente-de-programación)
- [Despliegue para tu equipo](#despliegue-para-tu-equipo)
- [Cómo funciona](#cómo-funciona)
- [Documentación](#documentación)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

## Qué puedes publicar

| Contenido | Qué puedes hacer |
| --- | --- |
| HTML, carpetas de sitios estáticos, ZIP | Subir y previsualizar sitios de una o varias páginas, incluida la salida de build como `dist/`. Las páginas HTML admiten edición visual del texto y edición del código fuente. |
| PDF | Leer en línea, buscar y extraer texto. |
| Documentos de Office, como PPTX y DOCX | Guardar y descargar los originales; activa Gotenberg para la vista previa en línea. |

Compila los proyectos web a archivos estáticos antes de subirlos; la plataforma no ejecuta backends de aplicaciones ni tareas de build. Los documentos PDF y de Office no admiten edición HTML visual, y las imágenes escaneadas no pasan por OCR automáticamente.

Las páginas alojadas se ejecutan en un entorno aislado y no pueden usar la sesión de inicio de sesión de la plataforma. Las conexiones a API externas requieren una lista de orígenes permitidos. Consulta los [límites de ejecución](../src/content/publish-skill.md) y el [diseño de seguridad](../SECURITY.md).

## Inicio rápido (despliegue local)

Con Git, Make, Docker 24+ y el plugin de Compose 2.24+ instalados, ejecuta estos comandos en una máquina Linux. No hace falta instalar Node ni disponer de dominio o proveedor de identidad.

```bash
git clone https://github.com/lexmount/artifact-site.git && cd artifact-site
cp .env.example .env
make build up
```

Una vez arrancado, abre **http://127.0.0.1:4300** y suelta HTML, una carpeta de sitio estático o un PDF para ver tu trabajo. Los sitios nuevos son privados por defecto; crea un enlace con el acceso deseado en compartir (Sharing) antes de enviárselo a alguien.

La primera ejecución descarga las dependencias y construye la imagen, y después arranca la aplicación y Postgres. Usa estos comandos en un clon recién hecho. El servicio solo es accesible localmente por defecto; `make down` lo detiene y conserva los datos. Para que tu equipo pueda acceder, sigue [Despliegue para tu equipo](#despliegue-para-tu-equipo).

<details>
<summary>¿No tienes un archivo para probar? Crea una página de ejemplo</summary>

```bash
printf '<!doctype html><meta charset="utf-8"><title>Hello</title><h1>Hello, artifact-site!</h1>' > hello.html
```

Suelta `hello.html` en la página de inicio (o elige **Upload**). Deberías ver «Hello, artifact-site!». Copia un enlace desde los ajustes de compartir; los enlaces de un despliegue local solo se abren en la misma máquina.

</details>

## Conectar un agente de programación

Abre **Agent guide** (la guía para agentes) en tu despliegue para elegir la vía del prompt, la CLI o MCP. `/for-agents#cli` y `/for-agents#mcp` ofrecen comandos específicos del servidor, pasos de autenticación y configuración de clientes. El MCP remoto autentica cada petición: ChatGPT, Claude y otros clientes compatibles con OAuth inician sesión en la página de consentimiento del propio servidor, y el resto de clientes lleva un token personal. Publicar, actualizar, compartir y eliminar con la CLI requieren un token; publicar crea por defecto un enlace público. Usa `--share none` (CLI) o `share: false` (MCP) para no compartir.

<p align="center"><img src="assets/agent.gif" alt="Un agente de programación publica una carpeta de build con la CLI de artifact-site y devuelve el enlace para compartir" width="820"></p>
<p align="center"><sub><b>O deja que lo haga tu agente de programación.</b> Con la guía para agentes (<code>/for-agents.md</code>), la CLI o el servidor MCP, «publica esto y dame un enlace» es una sola instrucción, y el sitio se puede actualizar, buscar y leer de la misma manera.</sub></p>

Dale esta instrucción a Claude Code, Cursor, Codex u otro agente de programación capaz de leer URL, con una dirección de servidor a la que pueda llegar. La página de inicio también ofrece un botón de copiar con la dirección de tu servidor ya rellenada:

```text
Publica la salida de este proyecto en artifact-site. Guía de publicación: https://your-server/for-agents.md
```

Los despliegues de equipo con OIDC admiten la aprobación de inicio de sesión de dispositivo; la instalación local anónima anterior no la necesita. El agente sigue la guía y la política de publicación del servidor para elegir la autenticación. Un agente en la nube no puede llegar directamente a `127.0.0.1` en tu ordenador.

La CLI requiere Node 24+. Hasta que se publique el paquete npm, sigue las [instrucciones de instalación de la CLI](../cli/README.md) para compilarla e instalarla desde el código fuente, y después ejecuta:

```bash
artifact-site login --base https://your-server        # inicio de sesión de dispositivo, una sola vez
artifact-site publish dist/ --title "Q3 dashboard"    # publicar y devolver enlaces
artifact-site find "quota"                           # buscar por contenido
artifact-site read YOUR_SITE_SLUG                    # sustituye por el slug de un sitio para leer su texto
```

El ejemplo de inicio de sesión requiere OIDC. El MCP remoto es un punto de entrada independiente y completo en `https://your-server/mcp`: no hace falta instalar la CLI. ChatGPT, Claude y cualquier cliente que implemente la autorización de MCP se conectan solo con la dirección e inician sesión en la página de consentimiento OAuth del servidor; para los demás clientes, la página `/for-agents#mcp` del despliegue crea un token personal y copia la configuración autenticada. Admite publicación, actualización, búsqueda, lectura, compartir, versiones, exportación y eliminación, incluidos archivos binarios y subida de directorios mediante las herramientas MCP.

Consulta los [comandos de la CLI](../cli/README.md) y la [configuración y herramientas del MCP remoto](MCP.md).

## Despliegue para tu equipo

Parte de [.env.example](../.env.example) y sigue [SELFHOST.md](../SELFHOST.md) para un despliegue en producción. Usa una dirección pública estable en `ARTIFACT_PUBLIC_URL`: de ella derivan las devoluciones de llamada del inicio de sesión, las comprobaciones de origen de las peticiones y la dirección que se entrega a los agentes:

- Define una `ARTIFACT_PUBLIC_URL` accesible y configura un proxy inverso, o define `ARTIFACT_WITH_CADDY=on` junto con `ARTIFACT_DOMAIN` para activar Caddy y los certificados automáticos.
- Elige una política de publicación. `login` requiere OIDC; `token` atiende a scripts o agentes con un token Bearer; `open` permite publicar a cualquiera que llegue al servicio y es adecuada para redes internas de confianza. La publicación anónima admite cuotas y caducidad propias.
- Conecta Google o un proveedor OIDC como Keycloak, Logto, Authentik, Okta o Auth0. Las cuentas son propietarias de sitios y carpetas; los agentes pueden recibir tokens de larga duración mediante el inicio de sesión de dispositivo. El valor por defecto `ARTIFACT_ENFORCE_OWNERSHIP=on` activa el control de acceso por cuenta en cuanto OIDC está configurado. Añade los correos de inicio de sesión verificados de los administradores a `ARTIFACT_ADMIN_EMAILS` para activar la consola de administración.
- Activa la vista previa de Office con `ARTIFACT_WITH_GOTENBERG=on`. La consola de administración gestiona retiradas, cuotas, caducidad de sitios anónimos e interruptores de política. Elige la visibilidad por defecto y programa las copias de seguridad.

La aplicación se distribuye como una sola imagen Docker, con Postgres incluido en la configuración de un solo host. Para usar una imagen preconstruida disponible, define `ARTIFACT_IMAGE` y ejecuta `make pull`. `make doctor` comprueba la configuración; `make backup` y `make restore` se encargan de las copias de seguridad y la recuperación. Para varias réplicas, Postgres externo y almacenamiento compatible con S3, consulta [DEPLOY.md](../DEPLOY.md).

## Cómo funciona

- **Aplicación y almacenamiento.** Next.js sirve la interfaz y la API, Postgres guarda los metadatos y los archivos residen en el disco local o en un almacenamiento compatible con S3. Una base de datos y un almacenamiento de objetos externos permiten varias réplicas de la aplicación.
- **Versiones inmutables.** Cada subida o edición escribe una nueva versión del archivo y conserva el contenido anterior. El bloqueo optimista (`expected_version`) detecta conflictos entre actualizaciones simultáneas.
- **Aislamiento del contenido.** Las vistas previas usan iframes aislados sin `allow-same-origin` y una CSP restrictiva para separar el contenido subido de la plataforma. Las comprobaciones de rutas y los límites de descompresión protegen frente al path traversal y las bombas ZIP.

Consulta [ARCHITECTURE.md](../ARCHITECTURE.md) para la arquitectura, el modelo de datos y los flujos de peticiones.

## Documentación

| Documento | Qué cubre |
| --- | --- |
| [SELFHOST.md](../SELFHOST.md) | Despliegue en una sola máquina con `make up`, copias de seguridad, actualizaciones, preguntas frecuentes |
| [DEPLOY.md](../DEPLOY.md) | Despliegue con varias réplicas: Postgres externo, almacenamiento de objetos, OIDC |
| [.env.example](../.env.example) | Todos los ajustes, agrupados y explicados |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Forma del sistema, modelo de datos, rutas de las peticiones, el entorno aislado |
| [SECURITY.md](../SECURITY.md) | Modelo de amenazas y cómo informar de una vulnerabilidad |
| [cli/README.md](../cli/README.md) | La CLI |
| [src/content/publish-skill.md](../src/content/publish-skill.md) | El contrato de la API y los límites de alojamiento, tal como se sirven a los agentes |
| [ROADMAP.md](../ROADMAP.md) | Lo que viene: búsqueda semántica, comentarios en los sitios y más |
| [CHANGELOG.md](../CHANGELOG.md) | Qué ha cambiado, versión a versión |

## Contribuir

El desarrollo local requiere Node 24+ y Docker:

```bash
npm install
make dev          # arrancar un Postgres desechable y el servidor de desarrollo
npm test          # pruebas unitarias, sin servicios externos
```

Consulta [CONTRIBUTING.md](../CONTRIBUTING.md) para el proceso de contribución, la firma DCO y los requisitos de CI. Informa de errores e ideas en [issues](https://github.com/lexmount/artifact-site/issues); plantea tus preguntas en [discussions](https://github.com/lexmount/artifact-site/discussions).

## Licencia

Con licencia, a tu elección,

- Apache License, versión 2.0 ([LICENSE-APACHE](../LICENSE-APACHE))
- Licencia MIT ([LICENSE-MIT](../LICENSE-MIT))

Salvo que indiques expresamente lo contrario, cualquier contribución que envíes intencionadamente para su inclusión en este proyecto quedará bajo esta doble licencia, sin términos ni condiciones adicionales.

© 2025–2026 LexMount. Los componentes de terceros se enumeran en [NOTICE](../NOTICE).
