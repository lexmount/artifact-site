<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/artifact-site-banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/artifact-site-banner.png">
    <img src="assets/artifact-site-banner.png" alt="artifact-site — Ein gemeinsamer Ort für KI-generierte Seiten und Dokumente, auf Ihrem eigenen Server. Open Source, selbst gehostet, bereit für Agenten." width="1000">
  </picture>
</p>

<h1 align="center">artifact-site</h1>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <strong>Deutsch</strong> |
  <a href="README.fr.md">Français</a> |
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml"><img src="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#lizenz"><img src="https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg" alt="Lizenz: Apache-2.0 OR MIT"></a>
  <a href="../.nvmrc"><img src="https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen.svg" alt="Node 24"></a>
  <a href="../ROADMAP.md"><img src="https://img.shields.io/badge/roadmap-what's%20next-8a5a2b.svg" alt="Roadmap"></a>
</p>

<p align="center"><sub>Diese Übersetzung wird zusammen mit der <a href="../README.md">englischen Fassung</a> gepflegt; bei Abweichungen gilt das Englische.</sub></p>

KI-Werkzeuge liefern jeden Tag mehr fertige Arbeit: interaktive Diagramme, Analyseberichte, Web-Prototypen und Foliensätze. Diese Arbeit landet oft verstreut in Chat-Verläufen, lokalen Ordnern und verschiedenen Tools, ohne einen gemeinsamen Ort, an dem man sie durchsehen, teilen oder pflegen kann. Jemandem etwas zu zeigen heißt immer noch: deployen, Dateien verschicken oder einen Screenshot machen; die neueste Version später wiederzufinden kostet zusätzliche Arbeit.

**artifact-site bringt diese Arbeit auf Ihren eigenen Server, als Links, die Sie teilen, aktualisieren und durchsuchen können.** Stellen Sie es sich als selbst gehosteten Arbeitsbereich für die Artefakte Ihres Teams vor, ähnlich wie Claude Artifacts oder OpenAI Sites: Ihre KI-Werkzeuge oder internen Tools erzeugen die Arbeit, artifact-site veröffentlicht und verwaltet sie. Laden Sie HTML, statische Websites oder Dokumente hoch, damit Ihr Team sie online ansehen, den Zugriff steuern und Revisionen behalten kann. Auch Coding-Agenten können vorhandene Arbeit veröffentlichen, aktualisieren, durchsuchen und lesen.

> **Ohne Installation ausprobieren:** [artifact-site.app.lexmount.com](https://artifact-site.app.lexmount.com/) betreibt diesen Code als gehosteten Dienst. Legen Sie eine Datei ab, um anonym zu veröffentlichen (anonyme Sites dort laufen nach einigen Tagen ab), oder melden Sie sich an, um Ihre Arbeit zu behalten. Es ist eine gemeinsame Demo – behandeln Sie alles, was Sie dort veröffentlichen, als öffentlich.

<p align="center"><img src="assets/demo.gif" alt="Ein HTML-Dashboard wird auf artifact-site gezogen: Innerhalb von Sekunden wird es zu einem Link, wird in einem Sandbox-Frame dargestellt, und das Freigabe-Panel kopiert den Link" width="820"></p>
<p align="center"><sub><b>Datei ablegen, Link erhalten, teilen.</b> Sehen Sie Ihre veröffentlichte Arbeit online an und legen Sie in den Freigabeeinstellungen fest, wer sie öffnen darf.</sub></p>

## Warum artifact-site

- **Arbeit an einem Ort behalten.** Ordnen Sie Seiten und Dokumente in Ordnern und finden Sie sie per Volltextsuche, auch auf Chinesisch. Teammitglieder und Agenten finden die Arbeit, auf die sie Zugriff haben.
- **Ablegen und teilen.** Laden Sie HTML, einen Build-Ordner, ein ZIP oder ein Dokument hoch und erhalten Sie einen Link. Große Websites werden in Teilen hochgeladen. Teilen Sie mit allen, mit angemeldeten Benutzern, mit bestimmten Personen oder mit Inhabern eines Zugangscodes.
- **Veröffentlichte Arbeit weiter verbessern.** Bearbeiten Sie HTML-Text oder -Quelltext im Browser, oder lassen Sie einen Agenten die ganze Website aktualisieren. Jede Änderung behält eine Version, mit Rollback und der Möglichkeit, eine Kopie zu speichern.
- **Agenten dort weitermachen lassen, wo sie aufgehört haben.** Veröffentlichen und aktualisieren Sie über den Leitfaden, die CLI oder MCP, suchen Sie dann nach Inhalt und lesen Sie extrahierbaren Text. Finden Sie zum Beispiel einen früheren Bericht und aktualisieren Sie ihn unter derselben Adresse, damit Ihr Team ihn ansehen kann.

## Inhalt

- [Was Sie veröffentlichen können](#was-sie-veröffentlichen-können)
- [Schnellstart (lokale Installation)](#schnellstart-lokale-installation)
- [Einen Coding-Agenten anbinden](#einen-coding-agenten-anbinden)
- [Für Ihr Team bereitstellen](#für-ihr-team-bereitstellen)
- [So funktioniert es](#so-funktioniert-es)
- [Dokumentation](#dokumentation)
- [Mitwirken](#mitwirken)
- [Lizenz](#lizenz)

## Was Sie veröffentlichen können

| Inhalt | Was Sie damit tun können |
| --- | --- |
| HTML, Ordner statischer Websites, ZIPs | Ein- oder mehrseitige Websites hochladen und in der Vorschau ansehen, einschließlich Build-Ausgaben wie `dist/`. HTML-Seiten unterstützen visuelle Textbearbeitung und Quelltextbearbeitung. |
| PDF | Online lesen, durchsuchen und Text extrahieren. |
| Office-Dokumente wie PPTX und DOCX | Originale speichern und herunterladen; Gotenberg für die Online-Vorschau aktivieren. |

Bauen Sie Webprojekte vor dem Hochladen zu statischen Dateien; die Plattform führt keine Anwendungs-Backends oder Build-Jobs aus. PDF- und Office-Dokumente unterstützen keine visuelle HTML-Bearbeitung, und gescannte Bilder werden nicht automatisch per OCR erfasst.

Gehostete Seiten laufen in einer Sandbox und können die Anmeldesitzung der Plattform nicht verwenden. Verbindungen zu externen APIs erfordern eine Origin-Allowlist. Siehe [Laufzeitgrenzen](../src/content/publish-skill.md) und [Sicherheitsdesign](../SECURITY.md).

## Schnellstart (lokale Installation)

Führen Sie mit installiertem Git, Make, Docker 24+ und Compose-Plugin 2.24+ diese Befehle auf einer Linux-Maschine aus. Weder eine Node-Installation noch eine Domain oder ein Identity-Provider ist nötig.

```bash
git clone https://github.com/lexmount/artifact-site.git && cd artifact-site
cp .env.example .env
make build up
```

Öffnen Sie nach dem Start **http://127.0.0.1:4300** und legen Sie HTML, einen Ordner mit einer statischen Website oder ein PDF ab, um Ihre Arbeit anzusehen. Neue Websites sind standardmäßig privat; erstellen Sie in der Freigabe (Sharing) einen Link mit dem gewünschten Zugriff, bevor Sie ihn an jemanden weitergeben.

Der erste Lauf lädt Abhängigkeiten herunter und baut das Image, dann startet er die App und Postgres. Verwenden Sie diese Befehle in einem frischen Klon. Der Dienst ist standardmäßig nur lokal erreichbar; `make down` stoppt ihn und behält die Daten. Um ihn für Ihr Team erreichbar zu machen, folgen Sie [Für Ihr Team bereitstellen](#für-ihr-team-bereitstellen).

<details>
<summary>Keine Datei zum Ausprobieren? Erstellen Sie eine Beispielseite</summary>

```bash
printf '<!doctype html><meta charset="utf-8"><title>Hello</title><h1>Hello, artifact-site!</h1>' > hello.html
```

Ziehen Sie `hello.html` auf die Startseite (oder wählen Sie **Upload**). Sie sollten „Hello, artifact-site!“ sehen. Kopieren Sie einen Link aus den Freigabeeinstellungen; Links einer lokalen Installation lassen sich nur auf derselben Maschine öffnen.

</details>

## Einen Coding-Agenten anbinden

Öffnen Sie in Ihrer Installation **Agent guide** (den Agenten-Leitfaden), um zwischen Prompt, CLI und MCP zu wählen. `/for-agents#cli` und `/for-agents#mcp` liefern serverspezifische Befehle, Authentifizierungsschritte und Client-Konfigurationen. Remote-MCP authentifiziert jede Anfrage: ChatGPT, Claude und andere OAuth-fähige Clients melden sich über die Zustimmungsseite des Servers an, andere Clients führen ein persönliches Token mit. Veröffentlichen, Aktualisieren, Teilen und Löschen über die CLI erfordern ein Token; das Veröffentlichen erzeugt standardmäßig eine öffentliche Freigabe. Mit `--share none` (CLI) oder `share: false` (MCP) überspringen Sie die Freigabe.

<p align="center"><img src="assets/agent.gif" alt="Ein Coding-Agent veröffentlicht einen Build-Ordner mit der artifact-site-CLI und gibt den Freigabelink zurück" width="820"></p>
<p align="center"><sub><b>Oder lassen Sie Ihren Coding-Agenten das erledigen.</b> Mit dem Agenten-Leitfaden (<code>/for-agents.md</code>), der CLI oder dem MCP-Server ist „veröffentliche das und gib mir einen Link“ eine einzige Anweisung – und die Website lässt sich auf demselben Weg aktualisieren, durchsuchen und lesen.</sub></p>

Geben Sie diese Anweisung an Claude Code, Cursor, Codex oder einen anderen Coding-Agenten, der URLs lesen kann, mit einer Serveradresse, die er erreichen kann. Die Startseite bietet außerdem einen Kopieren-Button mit bereits eingesetzter Serveradresse:

```text
Veröffentliche die Ausgabe dieses Projekts auf artifact-site. Anleitung zum Veröffentlichen: https://your-server/for-agents.md
```

Team-Installationen mit OIDC unterstützen die Bestätigung einer Geräteanmeldung; die anonyme lokale Installation oben braucht das nicht. Der Agent folgt dem Leitfaden und der Veröffentlichungsrichtlinie des Servers, um die Authentifizierung zu wählen. Ein Cloud-Agent kann `127.0.0.1` auf Ihrem Computer nicht direkt erreichen.

Die CLI erfordert Node 24+. Bis das npm-Paket veröffentlicht ist, folgen Sie der [CLI-Installationsanleitung](../cli/README.md), um sie aus dem Quelltext zu bauen und zu installieren, und führen Sie dann aus:

```bash
artifact-site login --base https://your-server        # einmalige Geräteanmeldung
artifact-site publish dist/ --title "Q3 dashboard"    # veröffentlichen und Links zurückgeben
artifact-site find "quota"                           # nach Inhalt suchen
artifact-site read YOUR_SITE_SLUG                    # durch einen Site-Slug ersetzen, um dessen Text zu lesen
```

Das Anmeldebeispiel erfordert OIDC. Remote-MCP ist ein eigener, vollständiger Zugang unter `https://your-server/mcp`: Eine CLI-Installation ist nicht nötig. ChatGPT, Claude und jeder Client, der die MCP-Autorisierung implementiert, verbinden sich allein mit der Adresse und melden sich über die OAuth-Zustimmungsseite des Servers an; für andere Clients erstellt die Seite `/for-agents#mcp` der Installation ein persönliches Token und kopiert die authentifizierte Konfiguration. Unterstützt werden Veröffentlichen, Aktualisieren, Suchen, Lesen, Teilen, Versionen, Export und Löschen, einschließlich Binärdateien und Verzeichnis-Uploads über MCP-Tools.

Siehe [CLI-Befehle](../cli/README.md) und [Einrichtung und Tools für Remote-MCP](MCP.md).

## Für Ihr Team bereitstellen

Beginnen Sie mit [.env.example](../.env.example) und folgen Sie [SELFHOST.md](../SELFHOST.md) für eine Produktionsinstallation. Verwenden Sie für `ARTIFACT_PUBLIC_URL` eine stabile öffentliche Adresse: Anmelde-Callbacks, Prüfungen des Anfrage-Origins und die an Agenten übergebene Adresse leiten sich daraus ab:

- Setzen Sie eine erreichbare `ARTIFACT_PUBLIC_URL` und richten Sie einen Reverse-Proxy ein, oder setzen Sie `ARTIFACT_WITH_CADDY=on` mit `ARTIFACT_DOMAIN`, um Caddy und automatische Zertifikate zu aktivieren.
- Wählen Sie eine Veröffentlichungsrichtlinie. `login` erfordert OIDC; `token` bedient Skripte oder Agenten mit einem Bearer-Token; `open` erlaubt jedem, der den Dienst erreicht, das Veröffentlichen und eignet sich für vertrauenswürdige interne Netze. Anonymes Veröffentlichen unterstützt eigene Kontingente und Ablauffristen.
- Binden Sie Google oder einen OIDC-Provider wie Keycloak, Logto, Authentik, Okta oder Auth0 an. Konten besitzen Websites und Ordner; Agenten können per Geräteanmeldung langlebige Tokens erhalten. Das Standard-`ARTIFACT_ENFORCE_OWNERSHIP=on` aktiviert die kontobasierte Zugriffskontrolle, sobald OIDC konfiguriert ist. Tragen Sie die verifizierten Anmelde-E-Mail-Adressen der Administratoren in `ARTIFACT_ADMIN_EMAILS` ein, um die Admin-Konsole zu aktivieren.
- Aktivieren Sie die Office-Vorschau mit `ARTIFACT_WITH_GOTENBERG=on`. Die Admin-Konsole verwaltet Sperrungen, Kontingente, den Ablauf anonymer Websites und Richtlinienschalter. Legen Sie die Standard-Sichtbarkeit fest und planen Sie Backups.

Die App wird als ein Docker-Image ausgeliefert, im Einzelhost-Setup mit gebündeltem Postgres. Um ein verfügbares vorgefertigtes Image zu verwenden, setzen Sie `ARTIFACT_IMAGE` und führen `make pull` aus. `make doctor` prüft die Konfiguration; `make backup` und `make restore` übernehmen Sicherung und Wiederherstellung. Für mehrere Replikate, externes Postgres und S3-kompatiblen Speicher siehe [DEPLOY.md](../DEPLOY.md).

## So funktioniert es

- **Anwendung und Speicher.** Next.js liefert UI und API, Postgres speichert Metadaten, und Dateien liegen auf der lokalen Festplatte oder in S3-kompatiblem Speicher. Externe Datenbank und Objektspeicher ermöglichen mehrere App-Replikate.
- **Unveränderliche Versionen.** Jeder Upload und jede Bearbeitung schreibt eine neue Dateiversion und bewahrt frühere Inhalte. Optimistisches Sperren (`expected_version`) erkennt Konflikte bei gleichzeitigen Aktualisierungen.
- **Isolation der Inhalte.** Vorschauen verwenden Sandbox-iframes ohne `allow-same-origin` und eine restriktive CSP, um hochgeladene Inhalte von der Plattform zu isolieren. Pfadprüfungen und Entpackgrenzen schützen vor Path Traversal und ZIP-Bomben.

Architektur, Datenmodell und Anfrageabläufe finden Sie in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Dokumentation

| Dokument | Inhalt |
| --- | --- |
| [SELFHOST.md](../SELFHOST.md) | Installation auf einer einzelnen Maschine mit `make up`, Backups, Upgrades, FAQ |
| [DEPLOY.md](../DEPLOY.md) | Installation mit mehreren Replikaten: externes Postgres, Objektspeicher, OIDC |
| [.env.example](../.env.example) | Jede Einstellung, gruppiert und erklärt |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | Systemaufbau, Datenmodell, Anfragepfade, die Sandbox |
| [SECURITY.md](../SECURITY.md) | Bedrohungsmodell und wie man eine Schwachstelle meldet |
| [cli/README.md](../cli/README.md) | Die CLI |
| [src/content/publish-skill.md](../src/content/publish-skill.md) | Der API-Vertrag und die Hosting-Grenzen, wie sie Agenten ausgeliefert werden |
| [ROADMAP.md](../ROADMAP.md) | Was als Nächstes kommt: semantische Suche, Kommentare zu Websites und mehr |
| [CHANGELOG.md](../CHANGELOG.md) | Was sich geändert hat, Release für Release |

## Mitwirken

Die lokale Entwicklung erfordert Node 24+ und Docker:

```bash
npm install
make dev          # ein temporäres Postgres und den Entwicklungsserver starten
npm test          # Unit-Tests, keine externen Dienste nötig
```

Siehe [CONTRIBUTING.md](../CONTRIBUTING.md) für den Beitragsprozess, das DCO-Sign-off und die CI-Anforderungen. Melden Sie Fehler und Ideen in den [Issues](https://github.com/lexmount/artifact-site/issues); stellen Sie Fragen in den [Discussions](https://github.com/lexmount/artifact-site/discussions).

## Lizenz

Lizenziert nach Ihrer Wahl unter

- Apache License, Version 2.0 ([LICENSE-APACHE](../LICENSE-APACHE))
- MIT-Lizenz ([LICENSE-MIT](../LICENSE-MIT))

Sofern Sie nicht ausdrücklich etwas anderes erklären, wird jeder Beitrag, den Sie absichtlich zur Aufnahme in dieses Projekt einreichen, wie oben doppelt lizenziert, ohne zusätzliche Bedingungen.

© 2025–2026 LexMount. Komponenten von Drittanbietern sind in [NOTICE](../NOTICE) aufgeführt.
