// =========================================================================
//  blobUtils — shared helpers for Azure Functions that list blobs
//  (used by the `library` HTTP function)
//
//  Auth model: Azure AD (Managed Identity in production, DefaultAzureCredential
//  chain locally) — no storage account key is used anywhere. SAS URLs are
//  signed with a User Delegation Key (Azure AD-issued), not an account key,
//  so this keeps working even when an org policy sets
//  `allowSharedKeyAccess=false` on the storage account.
// =========================================================================

const {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} = require("@azure/storage-blob");
const { DefaultAzureCredential } = require("@azure/identity");

// How long generated SAS URLs remain valid.
const SAS_EXPIRY_HOURS = 24;

// Reused across invocations (module-level) — DefaultAzureCredential caches
// tokens internally, and one BlobServiceClient per account is sufficient.
const credential = new DefaultAzureCredential();
const blobServiceClients = new Map();

function getBlobServiceClient(accountName) {
  if (!blobServiceClients.has(accountName)) {
    blobServiceClients.set(
      accountName,
      new BlobServiceClient(`https://${accountName}.blob.core.windows.net`, credential)
    );
  }
  return blobServiceClients.get(accountName);
}

/**
 * Turn a blob name into a human-friendly, title-cased display name.
 * e.g. "my_cool-demo.mp4" -> "My Cool Demo"
 */
function toTitle(blobName) {
  const base = blobName.replace(/\.[^.]+$/, ""); // strip extension
  return base
    .replace(/[-_]+/g, " ") // dashes/underscores -> spaces
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

/**
 * Look for a display-name style metadata field on a blob (checked before
 * falling back to a filename-derived title). Blob metadata keys are
 * case-insensitive, so match loosely against common variants.
 */
function getMetadataTitle(metadata) {
  if (!metadata) return null;
  const key = Object.keys(metadata).find((k) => /^(display[-_]?name|title)$/i.test(k));
  return key ? metadata[key] : null;
}

/**
 * List blobs in a container whose name matches `extensionRegex`, returning
 * metadata + a playable/readable URL (direct if public, otherwise a
 * short-lived read-only SAS URL signed with a User Delegation Key).
 *
 * `prefix` (optional) scopes listing to a folder, e.g. "ai/" or "copilot/" —
 * this is the sole signal used for category grouping (no filename prefixes
 * or custom metadata are used for categorization). The prefix is stripped
 * off before deriving a title from the filename.
 *
 * Returns { ok: true, items } on success, or { ok: false, status, error }
 * on a handled failure (missing config, missing container, etc).
 */
async function listContainerBlobs({
  accountName,
  containerName,
  isPublic,
  extensionRegex,
  prefix = "",
  context,
}) {
  if (!accountName) {
    context.error("AZURE_STORAGE_ACCOUNT_NAME is not set.");
    return {
      ok: false,
      status: 500,
      error: "Server is not configured. Missing AZURE_STORAGE_ACCOUNT_NAME app setting.",
    };
  }

  const blobServiceClient = getBlobServiceClient(accountName);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  const exists = await containerClient.exists();
  if (!exists) {
    context.warn(`Container "${containerName}" does not exist.`);
    return { ok: true, items: [] };
  }

  // Pre-compute SAS validity window (start 5 min in the past for clock skew).
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + SAS_EXPIRY_HOURS * 60 * 60 * 1000);

  let userDelegationKey = null;
  if (!isPublic) {
    try {
      userDelegationKey = await blobServiceClient.getUserDelegationKey(startsOn, expiresOn);
    } catch (err) {
      context.error("Failed to get user delegation key:", err.message);
      return {
        ok: false,
        status: 500,
        error:
          "Cannot generate SAS URLs. The app's managed identity needs the " +
          "'Storage Blob Data Reader' role on the storage account (or set PUBLIC_CONTAINER=true).",
      };
    }
  }

  const items = [];

  for await (const blob of containerClient.listBlobsFlat({
    prefix: prefix || undefined,
    includeMetadata: true,
  })) {
    if (!extensionRegex.test(blob.name)) continue;

    const blobClient = containerClient.getBlobClient(blob.name);
    let url;

    if (isPublic) {
      url = blobClient.url;
    } else {
      const sas = generateBlobSASQueryParameters(
        {
          containerName,
          blobName: blob.name,
          permissions: BlobSASPermissions.parse("r"), // read only
          startsOn,
          expiresOn,
          protocol: SASProtocol.Https,
        },
        userDelegationKey,
        accountName
      ).toString();
      url = `${blobClient.url}?${sas}`;
    }

    const sizeBytes = blob.properties.contentLength || 0;
    const modified =
      blob.properties.lastModified instanceof Date
        ? blob.properties.lastModified.toISOString()
        : new Date(blob.properties.lastModified || Date.now()).toISOString();

    // Category folders (e.g. "ai/", "copilot/") are the only categorization
    // signal — strip the prefix off before deriving a filename-based title.
    const nameForTitle =
      prefix && blob.name.startsWith(prefix) ? blob.name.slice(prefix.length) : blob.name;

    items.push({
      title: getMetadataTitle(blob.metadata) || toTitle(nameForTitle),
      filename: blob.name,
      sizeMB: Math.round((sizeBytes / (1024 * 1024)) * 10) / 10,
      modified,
      url,
    });
  }

  // Newest first.
  items.sort((a, b) => new Date(b.modified) - new Date(a.modified));

  return { ok: true, items };
}

module.exports = {
  SAS_EXPIRY_HOURS,
  toTitle,
  listContainerBlobs,
};
