<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/artifact-site-banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/artifact-site-banner.png">
    <img src="assets/artifact-site-banner.png" alt="artifact-site — AI が生成したページやドキュメントを、自分のサーバー上でまとめて管理する場所。オープンソース、セルフホスト、エージェント対応。" width="1000">
  </picture>
</p>

<h1 align="center">artifact-site</h1>

<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a> |
  <strong>日本語</strong> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml"><img src="https://github.com/lexmount/artifact-site/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#ライセンス"><img src="https://img.shields.io/badge/license-Apache--2.0%20OR%20MIT-blue.svg" alt="ライセンス: Apache-2.0 OR MIT"></a>
  <a href="../.nvmrc"><img src="https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen.svg" alt="Node 24"></a>
  <a href="../ROADMAP.md"><img src="https://img.shields.io/badge/roadmap-what's%20next-8a5a2b.svg" alt="ロードマップ"></a>
  <a href="https://www.npmjs.com/package/@artifact-site/cli"><img src="https://img.shields.io/npm/v/@artifact-site/cli" alt="npm"></a>
  <a href="https://github.com/lexmount/artifact-site/releases/latest"><img src="https://img.shields.io/github/v/release/lexmount/artifact-site" alt="GitHub Release"></a>
</p>

<p align="center"><sub>この文書は<a href="../README.md">英語版</a>と同期して更新しています。内容に相違がある場合は英語版が優先します。</sub></p>

今では多くの AI エージェントを選べますが、成果物はパソコン、チャット履歴、各プラットフォームのクラウドに散らばり、まとめて管理・共有したり、振り返ったりするのが難しくなっています。

**artifact-site は、Claude Artifacts や OpenAI Sites に似た、個人・チーム向けのセルフホスト型ワークスペースです。** さまざまなエージェントが作成を担当し、artifact-site が成果物を一元管理します。ページやドキュメントをリンクにして、共有、コメントやフィードバック、アクセス制御、バージョン管理を容易にします。使い慣れたエージェントも CLI や MCP を通じて、編集・公開・検索・更新を続けられます。

> **[ライブデモを試す](https://artifact-site.app.lexmount.com/)** — インストール不要。ファイルをドラッグ＆ドロップするだけで公開され、サインインなしで共有リンクを取得できます。
>
> 匿名でアップロードした内容は数日で期限切れになります。公開デモ環境のため、機密情報はアップロードしないでください。

<p align="center"><img src="assets/demo.gif" alt="HTML のダッシュボードを artifact-site にドロップすると、数秒でリンクになり、サンドボックス化されたフレームで表示され、共有パネルからリンクをコピーできる" width="820"></p>
<p align="center"><sub><b>ファイルをドロップして、リンクを受け取り、共有する。</b>公開した成果物をオンラインで確認し、共有設定で誰が開けるかを決められます。</sub></p>

## artifact-site を選ぶ理由

- **成果物を一か所に。** ページやドキュメントをフォルダーで整理し、全文検索（中国語にも対応）で探せます。チームメンバーもエージェントも、権限のある成果物を見つけられます。
- **ドロップするだけで共有。** HTML、ビルドフォルダー、ZIP、ドキュメントをアップロードするとリンクが得られます。大きなサイトは分割してアップロードされます。全員、サインイン済みユーザー、指定した人、アクセスコードを持つ人に共有できます。
- **公開後も改善を続けられる。** ブラウザー上で HTML のテキストやソースを編集するか、エージェントにサイト全体を更新させます。変更のたびにバージョンが残り、ロールバックやコピーの保存もできます。
- **エージェントが続きから作業できる。** ガイド、CLI、MCP から公開・更新し、内容で検索して抽出可能なテキストを読み取ります。たとえば以前のレポートを見つけ、同じアドレスで更新して、チームに新しい版を見てもらえます。

## ホスティング製品との比較

| チームの検討事項 | Claude Artifacts / Claude Code Artifacts | ChatGPT Sites（OpenAI） | artifact-site |
| --- | --- | --- | --- |
| ホスティング | Anthropic が管理 | OpenAI が管理 | **自分のサーバー**。ファイルはローカルまたは S3 互換ストレージに保存 |
| 公開方法 | Claude / Claude Code 内 | ChatGPT Sites 内 | ファイルアップロード、CLI、リモート MCP で**任意のツール**から |
| 主なコンテンツ | インタラクティブな成果物 | ホストされた Web サイトやアプリ | 静的 HTML、ビルドフォルダー、ZIP、PDF、Office ドキュメント¹ |
| 認証基盤 | Claude アカウント | ChatGPT アカウント | Google、Keycloak、Okta などの**自分の OIDC プロバイダー** |

¹ Office のオンラインプレビューには Gotenberg が必要です。artifact-site は完成したファイルをホストし、アプリのバックエンドやビルド処理は実行しません。

Claude Artifacts と ChatGPT Sites は、作成とホスティングによる共有を組み合わせています。artifact-site はこれらのワークフローを補完し、さまざまなツールで作ったページやドキュメントを、自分のインフラ上の共有スペースに集めます。

製品の機能や共有方法はプランによって異なり、変更されます。公式の [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) と [ChatGPT Sites](https://learn.chatgpt.com/docs/sites) のガイドを参照してください。

## 目次

- [公開できるもの](#公開できるもの)
- [クイックスタート（ローカル環境）](#クイックスタートローカル環境)
- [コーディングエージェントとの連携](#コーディングエージェントとの連携)
- [チームへの展開](#チームへの展開)
- [仕組み](#仕組み)
- [ドキュメント](#ドキュメント)
- [コントリビューション](#コントリビューション)
- [ライセンス](#ライセンス)

## 公開できるもの

| コンテンツ | できること |
| --- | --- |
| HTML、静的サイトのフォルダー、ZIP | 単一ページまたは複数ページのサイトをアップロードしてプレビューします。`dist/` などのビルド出力にも対応。HTML ページはビジュアルなテキスト編集とソース編集ができます。 |
| PDF | オンラインで閲覧し、検索し、テキストを抽出します。 |
| Office 文書（PPTX、DOCX など） | 原本を保存・ダウンロードします。Gotenberg を有効にするとオンラインでプレビューできます。 |

Web プロジェクトはアップロード前に静的ファイルへビルドしてください。プラットフォームはアプリケーションのバックエンドやビルドジョブを実行しません。PDF と Office 文書はビジュアルな HTML 編集に対応せず、スキャン画像は自動で OCR されません。

ホストされたページはサンドボックス内で動作し、プラットフォームのログインセッションを使えません。外部 API への接続にはオリジンの許可リストが必要です。[実行時の制限](../src/content/publish-skill.md)と[セキュリティ設計](../SECURITY.md)を参照してください。

## クイックスタート（ローカル環境）

試すだけなら、インストール不要の[ライブデモ](https://artifact-site.app.lexmount.com/)を利用できます。ローカルにデプロイするには、以下の 3 コマンドを実行します。Git、Make、Bash、Docker 24 以上、Compose プラグイン 2.24 以上が必要です。macOS では Docker Desktop を、Windows では Docker Desktop の WSL 連携を有効にした WSL2 を使って実行してください。Node、ドメイン、認証プロバイダーの設定は不要です。

```bash
git clone https://github.com/lexmount/artifact-site.git && cd artifact-site
cp .env.example .env
make build up
```

起動したら **http://127.0.0.1:4300** を開き、HTML、静的サイトのフォルダー、PDF をドロップして成果物を表示します。新しいサイトはデフォルトで非公開です。誰かに送る前に、共有設定（Sharing）で必要なアクセス権を持つリンクを作成してください。

初回の実行では依存関係のダウンロードとイメージのビルドを行い、その後アプリと Postgres を起動します。これらのコマンドは新しくクローンした直後の状態で使ってください。サービスはデフォルトでローカル専用です。`make down` で停止し、データは保持されます。チームからアクセスできるようにするには、[チームへの展開](#チームへの展開)に従ってください。

<details>
<summary>試すファイルがない場合は、サンプルページを作成します</summary>

```bash
printf '<!doctype html><meta charset="utf-8"><title>Hello</title><h1>Hello, artifact-site!</h1>' > hello.html
```

`hello.html` をホームページにドロップ（または **Upload** を選択）します。「Hello, artifact-site!」が表示されるはずです。共有設定からリンクをコピーしてください。ローカル環境のリンクは同じマシンでしか開けません。

</details>

## コーディングエージェントとの連携

エージェントに合った入口を選んでください。

- **Skill**: `npx skills add lexmount/artifact-site` — [エージェントスキル](../skills/artifact-site/SKILL.md)をインストールし、サーバーの URL をエージェントに伝えます。
- **CLI**: `npm install -g @artifact-site/cli` — Node 24 以上が必要です。コマンド例は以下をご覧ください。
- **MCP**: `https://your-server/mcp` — ChatGPT、Claude などの MCP クライアントから、サーバーの OAuth サインインで接続します。CLI のインストールは不要です。

**CLI と MCP での公開は、デフォルトで公開共有リンクを作成します。** 共有しない場合は `--share none`（CLI）または `share: false`（MCP）を使ってください。

<p align="center"><img src="assets/agent.gif" alt="コーディングエージェントが artifact-site の CLI でビルドフォルダーを公開し、共有リンクを返す" width="820"></p>
<p align="center"><sub><b>あるいはコーディングエージェントに任せる。</b>エージェントガイド（<code>/for-agents.md</code>）、CLI、MCP サーバーがあれば、「これを公開してリンクをください」の一言で済みます。更新、検索、読み取りも同じように頼めます。</sub></p>

次の指示を Claude Code、Cursor、Codex など URL を読めるコーディングエージェントに渡します。サーバーのアドレスは、エージェントが到達できるものに置き換えてください。ホームページには、サーバーのアドレスを埋めた状態でコピーできるボタンもあります。

```text
このプロジェクトの成果物を artifact-site に公開してください。公開ガイド: https://your-server/for-agents.md
```

CLI の例（`login` には OIDC が必要です）：

```bash
artifact-site login --base https://your-server        # 一度きりのデバイスサインイン
artifact-site publish dist/ --title "Q3 dashboard"    # 公開してリンクを返す
artifact-site find "quota"                           # 内容で検索
artifact-site read YOUR_SITE_SLUG                    # サイトのスラッグに置き換えてテキストを読む
```

<details>
<summary>認証の詳細</summary>

デプロイ先で **Agent guide**（エージェントガイド）を開き、プロンプト、CLI、MCP のいずれかの方法を選びます。`/for-agents#cli` と `/for-agents#mcp` に、サーバー固有のコマンド、認証手順、クライアント設定があります。リモート MCP はすべてのリクエストを認証します。ChatGPT、Claude など OAuth に対応したクライアントはサーバー自身の同意ページからサインインし、その他のクライアントは個人トークンを持たせます。CLI での公開、更新、共有、削除にはトークンが必要です。公開するとデフォルトで公開共有が作成されます。共有しない場合は `--share none`（CLI）または `share: false`（MCP）を使います。

OIDC を設定したチーム向けのデプロイでは、デバイスサインインの承認に対応しています。上記の匿名ローカル環境では不要です。エージェントはガイドとサーバーの公開ポリシーに従って認証方法を選びます。クラウド上のエージェントは、あなたのコンピューターの `127.0.0.1` に直接アクセスできません。

上記のログイン例には OIDC が必要です。リモート MCP は `https://your-server/mcp` にある独立した完全な入口で、CLI のインストールは不要です。ChatGPT、Claude をはじめ MCP の認可仕様を実装したクライアントは、このアドレスだけで接続し、サーバーの OAuth 同意ページでサインインします。その他のクライアントは、デプロイ先の `/for-agents#mcp` ページで個人トークンを作成し、認証済みの設定をコピーします。公開、更新、検索、読み取り、共有、バージョン管理、エクスポート、削除に対応し、バイナリファイルやディレクトリのアップロードも MCP ツールから行えます。

[CLI コマンド](../cli/README.md)と[リモート MCP の設定とツール](MCP.md)を参照してください。

</details>

## チームへの展開

[.env.example](../.env.example) から始め、本番環境のデプロイは [SELFHOST.md](../SELFHOST.md) に従ってください。`ARTIFACT_PUBLIC_URL` には安定した公開アドレスを使います。サインインのコールバック、リクエスト元の検証、エージェントに渡すアドレスは、この値から導かれます。

- 到達可能な `ARTIFACT_PUBLIC_URL` を設定してリバースプロキシを構成するか、`ARTIFACT_WITH_CADDY=on` と `ARTIFACT_DOMAIN` を設定して Caddy と自動証明書を有効にします。
- 公開ポリシーを選びます。`login` には OIDC が必要です。`token` は Bearer トークンを持つスクリプトやエージェント向けです。`open` はサービスに到達できる誰でも公開でき、信頼できる社内ネットワークに向いています。匿名公開には個別のクォータと有効期限を設定できます。
- Google、または Keycloak、Logto、Authentik、Okta、Auth0 などの OIDC プロバイダーを接続します。サイトとフォルダーはアカウントに帰属し、エージェントはデバイスサインインで長期トークンを受け取れます。デフォルトの `ARTIFACT_ENFORCE_OWNERSHIP=on` は、OIDC を設定するとアカウントに基づくアクセス制御を有効にします。管理者の検証済みサインインメールアドレスを `ARTIFACT_ADMIN_EMAILS` に追加すると、管理コンソールが有効になります。
- `ARTIFACT_WITH_GOTENBERG=on` で Office のプレビューを有効にします。管理コンソールでは、サイトの取り下げ、クォータ、匿名サイトの有効期限、ポリシーの切り替えを管理できます。デフォルトの公開範囲を決め、バックアップをスケジュールしてください。

アプリは 1 つの Docker イメージとして提供され、単一ホスト構成では Postgres が同梱されます。用意されたビルド済みイメージを使うには、`ARTIFACT_IMAGE` を設定して `make pull` を実行します。`make doctor` は設定を確認し、`make backup` と `make restore` はバックアップと復元を担います。複数レプリカ、外部の Postgres、S3 互換ストレージについては [DEPLOY.md](../DEPLOY.md) を参照してください。

## 仕組み

- **アプリケーションとストレージ。** Next.js が UI と API を提供し、Postgres がメタデータを保存し、ファイルはローカルディスクまたは S3 互換ストレージに置かれます。外部データベースとオブジェクトストレージを使えば、複数のアプリレプリカを動かせます。
- **不変のバージョン。** アップロードや編集のたびに新しいファイルバージョンを書き込み、過去の内容を保持します。楽観的ロック（`expected_version`）で同時更新の競合を検出します。
- **コンテンツの分離。** プレビューは `allow-same-origin` を付けないサンドボックス化された iframe と厳格な CSP を使い、アップロードされた内容をプラットフォームから隔離します。パスの検査と展開サイズの上限で、パストラバーサルと ZIP 爆弾を防ぎます。

アーキテクチャ、データモデル、リクエストの流れは [ARCHITECTURE.md](../ARCHITECTURE.md) を参照してください。

## ドキュメント

| ドキュメント | 内容 |
| --- | --- |
| [SELFHOST.md](../SELFHOST.md) | `make up` による単一マシンへのデプロイ、バックアップ、アップグレード、FAQ |
| [DEPLOY.md](../DEPLOY.md) | 複数レプリカのデプロイ: 外部 Postgres、オブジェクトストレージ、OIDC |
| [.env.example](../.env.example) | すべての設定項目を分類して解説 |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | システム構成、データモデル、リクエストの経路、サンドボックス |
| [SECURITY.md](../SECURITY.md) | 脅威モデルと脆弱性の報告方法 |
| [cli/README.md](../cli/README.md) | CLI |
| [src/content/publish-skill.md](../src/content/publish-skill.md) | エージェントに配信される API 契約とホスティングの制限 |
| [ROADMAP.md](../ROADMAP.md) | 今後の予定: セマンティック検索、サイトへのコメントなど |
| [CHANGELOG.md](../CHANGELOG.md) | リリースごとの変更内容 |

## コントリビューション

ローカル開発には Node 24 以上と Docker が必要です。

```bash
npm install
make dev          # 使い捨ての Postgres と開発サーバーを起動
npm test          # ユニットテスト。外部サービスは不要
```

コントリビューションの流れ、DCO の署名、CI の要件は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。バグや提案は [issues](https://github.com/lexmount/artifact-site/issues) へ、質問は [discussions](https://github.com/lexmount/artifact-site/discussions) へお寄せください。

artifact-site が役に立ったら、⭐ でほかの人にも見つけてもらえます。チームで利用中ですか？ [Discussions](https://github.com/lexmount/artifact-site/discussions) でお知らせください。利用チームとしてぜひ紹介させてください。

## ライセンス

次のいずれかのライセンスを選択できます。

- Apache License, Version 2.0（[LICENSE-APACHE](../LICENSE-APACHE)）
- MIT license（[LICENSE-MIT](../LICENSE-MIT)）

明示的に別段の表明をしない限り、あなたが本プロジェクトへの取り込みを意図して提出した貢献は、追加の条項や条件なしに上記のデュアルライセンスで提供されるものとします。

© 2025–2026 LexMount. サードパーティのコンポーネントは [NOTICE](../NOTICE) に記載しています。
