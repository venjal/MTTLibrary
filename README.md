# AI Lab · Video Library

A futuristic, dark-themed **Azure Static Web App** for sharing videos and
HTML ebooks. Content lives in **Azure Blob Storage** containers and is listed
dynamically by an **Azure Functions** API — so newly uploaded videos/ebooks
appear automatically with **no rebuild and no redeploy**.

- **Frontend** (`/`) — plain HTML/CSS/JS, no framework, no CDN. Animated
  particle backdrop, glassmorphism cards, neon cyan/violet accents, real-time
  search across both videos and ebooks, and an accessible modal that plays
  video or renders an HTML ebook in a sandboxed reader.
- **API** (`/api`) — Azure Functions (Node.js, programming model **v4**) with
  two HTTP functions: `videos` at `GET /api/videos` and `ebooks` at
  `GET /api/ebooks`. Both share the same blob-listing logic in
  `api/src/lib/blobUtils.js`.
- Private containers by default — the API mints **short-lived read-only SAS
  URLs** (4-hour expiry) per blob. Optionally serve direct URLs from a public
  container.

---

## Project structure

```
.
├── index.html                       # Frontend markup
├── styles.css                       # Futuristic theme
├── app.js                           # Fetch + render + search + modal
├── staticwebapp.config.json         # MIME types, routes, caching headers
├── api/                             # Azure Functions app
│   ├── package.json                 # @azure/storage-blob dependency
│   ├── host.json
│   ├── local.settings.json.example  # Copy to local.settings.json for local dev
│   └── src/
│       ├── functions/videos.js      # GET /api/videos
│       ├── functions/ebooks.js      # GET /api/ebooks
│       └── lib/blobUtils.js         # Shared blob-listing/SAS helpers
├── .github/workflows/
│   └── azure-static-web-apps.yml    # CI/CD placeholder (Azure generates its own)
├── .gitignore
└── README.md
```

---

## How the API works

`GET /api/videos` returns:

```json
{
  "videos": [
    {
      "title": "My Cool Demo",
      "filename": "my_cool-demo.mp4",
      "sizeMB": 42.7,
      "modified": "2026-07-16T10:20:00.000Z",
      "url": "https://<account>.blob.core.windows.net/videos/my_cool-demo.mp4?<sas>"
    }
  ]
}
```

`GET /api/ebooks` returns the same shape under an `"ebooks"` key, listing
`.html` blobs instead:

```json
{
  "ebooks": [
    {
      "title": "Intro To Neural Nets",
      "filename": "intro-to-neural-nets.html",
      "sizeMB": 1.2,
      "modified": "2026-07-16T10:20:00.000Z",
      "url": "https://<account>.blob.core.windows.net/ebooks/intro-to-neural-nets.html?<sas>"
    }
  ]
}
```

App settings the functions read:

| Setting | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | ✅ | — | Full storage connection string (needs `AccountKey` to sign SAS). |
| `VIDEOS_CONTAINER` | ❌ | `videos` | Blob container `videos` lists `.mp4` from. |
| `EBOOKS_CONTAINER` | ❌ | `ebooks` | Blob container `ebooks` lists `.html` from. |
| `PUBLIC_CONTAINER` | ❌ | `false` | `true` → return direct blob URLs; otherwise generate SAS URLs. |

- **Empty/missing container** → `200 { "videos": [] }` (or `{ "ebooks": [] }`).
- **Missing connection string** → `500` with a helpful message.
- **Storage errors** → `500` with detail.

---

## Deploy — step by step

### 1. Create the Storage Account + blob container

Using the Azure CLI (replace names as needed):

```bash
# Variables
RG=ai-lab-rg
LOCATION=eastus
STORAGE=ailabvideos$RANDOM      # must be globally unique, lowercase

# Resource group
az group create --name $RG --location $LOCATION

# Storage account
az storage account create \
  --name $STORAGE \
  --resource-group $RG \
  --location $LOCATION \
  --sku Standard_LRS \
  --kind StorageV2

# Private containers (recommended — the API generates SAS URLs)
az storage container create \
  --name videos \
  --account-name $STORAGE \
  --auth-mode login

az storage container create \
  --name ebooks \
  --account-name $STORAGE \
  --auth-mode login
```

> To serve **direct** URLs instead of SAS, create the containers with
> `--public-access blob` and set `PUBLIC_CONTAINER=true` later.

Grab the connection string (you'll need it in step 4):

```bash
az storage account show-connection-string \
  --name $STORAGE --resource-group $RG --query connectionString -o tsv
```

### 2. Upload videos and ebooks with AzCopy

Get a SAS for each container (write access), then copy everything from your
local folder. Run this **every time you add new videos or ebooks** — the app
picks them up automatically on the next page load.

```powershell
# Generate a temporary write/list SAS for a container (PowerShell)
$end = (Get-Date).AddHours(2).ToString("yyyy-MM-ddTHH:mmZ")

$sas = az storage container generate-sas `
  --account-name $STORAGE `
  --name videos `
  --permissions acwl `
  --expiry $end `
  --auth-mode login --as-user `
  -o tsv

# Upload all files from C:\labtesting\videos (recursive) to the videos container
azcopy copy "C:\labtesting\videos\*" `
  "https://$STORAGE.blob.core.windows.net/videos?$sas" `
  --recursive=true
```

Same pattern for ebooks — each `.html` file is one self-contained ebook:

```powershell
$sas = az storage container generate-sas `
  --account-name $STORAGE `
  --name ebooks `
  --permissions acwl `
  --expiry $end `
  --auth-mode login --as-user `
  -o tsv

azcopy copy "C:\labtesting\ebooks\*.html" `
  "https://$STORAGE.blob.core.windows.net/ebooks?$sas" `
  --recursive=true
```

> **Repeat these AzCopy steps whenever you add new videos or ebooks.** No
> rebuild or redeploy is required — `/api/videos` and `/api/ebooks` re-read
> their containers on every request.

### 3. Create the Static Web App and link GitHub

1. Push this repo to GitHub.
2. In the Azure Portal: **Create a resource → Static Web App**.
3. Sign in to GitHub, pick your **repo** and **branch** (`main`).
4. Build details:
   - **App location:** `/`
   - **Api location:** `api`
   - **Output location:** *(leave blank)*
5. Create. Azure commits its own workflow file to `.github/workflows/` and adds
   the deployment token secret to your repo. The included
   `azure-static-web-apps.yml` is only a **placeholder/reference** — Azure's
   generated file takes precedence.

CLI alternative:

```bash
az staticwebapp create \
  --name ai-lab-video-swa \
  --resource-group $RG \
  --location eastus2 \
  --source https://github.com/<you>/<repo> \
  --branch main \
  --app-location "/" \
  --api-location "api" \
  --output-location "" \
  --login-with-github
```

### 4. Set the app settings in the Static Web App

Portal: **Static Web App → Settings → Environment variables** (Application),
add:

- `AZURE_STORAGE_CONNECTION_STRING` = *(from step 1)*
- `VIDEOS_CONTAINER` = `videos`
- `EBOOKS_CONTAINER` = `ebooks`
- `PUBLIC_CONTAINER` = `false`

CLI:

```bash
az staticwebapp appsettings set \
  --name ai-lab-video-swa \
  --setting-names \
    AZURE_STORAGE_CONNECTION_STRING="<connection-string>" \
    VIDEOS_CONTAINER="videos" \
    EBOOKS_CONTAINER="ebooks" \
    PUBLIC_CONTAINER="false"
```

> These are applied to the managed Functions API. No redeploy needed for the
> settings to take effect.

### 5. Run locally with the SWA CLI + Functions Core Tools

Prerequisites:

- [Node.js 18+](https://nodejs.org)
- [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
- SWA CLI: `npm install -g @azure/static-web-apps-cli`

Steps:

```bash
# 1. Install API dependencies
cd api
npm install
cd ..

# 2. Configure local settings for the Functions app
#    Copy the example and fill in your connection string.
copy api\local.settings.json.example api\local.settings.json   # Windows
# cp api/local.settings.json.example api/local.settings.json    # macOS/Linux
```

Edit `api/local.settings.json`:

```json
{
  "IsEncrypted": false,
  "Values": {
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "AzureWebJobsStorage": "",
    "AZURE_STORAGE_CONNECTION_STRING": "<your-connection-string>",
    "VIDEOS_CONTAINER": "videos",
    "EBOOKS_CONTAINER": "ebooks",
    "PUBLIC_CONTAINER": "false"
  }
}
```

Start everything with the SWA emulator (serves the frontend and proxies
`/api/*` to the Functions host):

```bash
swa start . --api-location api
```

Then open **http://localhost:4280**. The SWA CLI launches the Functions Core
Tools for the API automatically. (To run the API on its own instead:
`cd api && func start`.)

---

## Notes & tips

- **SAS expiry** is 4 hours (`SAS_EXPIRY_HOURS` in `api/src/lib/blobUtils.js`,
  shared by both functions). Responses are sent with `Cache-Control: no-store`
  so expired URLs aren't cached at the edge.
- `videos` only lists `.mp4` blobs; `ebooks` only lists `.html` blobs. Adjust
  the `extensionRegex` passed to `listContainerBlobs()` in each function to
  support more formats.
- Ebooks are opened in a sandboxed `<iframe>` (`sandbox="allow-scripts
  allow-popups"` — deliberately **without** `allow-same-origin`) so untrusted
  HTML content can't escape the sandbox to access the parent page or cookies.
- Keep secrets out of source control — `local.settings.json` is gitignored.
- Titles are derived from blob names: extension stripped, `-`/`_` → spaces,
  Title Cased.

## License

MIT — use freely.
