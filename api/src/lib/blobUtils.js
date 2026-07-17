// =========================================================================
//  blobUtils — shared helpers for Azure Functions that list blobs
//  (used by both the `videos` and `ebooks` functions)
// =========================================================================

const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} = require("@azure/storage-blob");

// How long generated SAS URLs remain valid.
// NOTE: 1 year is a long-lived bearer credential — anyone who obtains a
// generated URL (browser history, proxy/access logs, a forwarded link,
// etc.) gets a full year of read access to that blob with no way to
// revoke just that link (it's signed with the account key, not a
// revocable stored access policy). Rotating the storage account key is
// the only way to invalidate every outstanding token early.
const SAS_EXPIRY_HOURS = 365 * 24;

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
 * Parse AccountName and AccountKey out of a storage connection string.
 * Needed to sign SAS tokens when the container is private.
 */
function parseConnectionString(connStr) {
  const parts = {};
  connStr.split(";").forEach((segment) => {
    const idx = segment.indexOf("=");
    if (idx > -1) {
      const key = segment.slice(0, idx).trim();
      const value = segment.slice(idx + 1).trim();
      if (key) parts[key] = value;
    }
  });
  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
  };
}

/**
 * List blobs in a container whose name matches `extensionRegex`, returning
 * metadata + a playable/readable URL (direct if public, otherwise a
 * short-lived read-only SAS URL).
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
  connectionString,
  containerName,
  isPublic,
  extensionRegex,
  prefix = "",
  context,
}) {
  if (!connectionString) {
    context.error("AZURE_STORAGE_CONNECTION_STRING is not set.");
    return {
      ok: false,
      status: 500,
      error:
        "Server is not configured. Missing AZURE_STORAGE_CONNECTION_STRING app setting.",
    };
  }

  const blobServiceClient =
    BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  const exists = await containerClient.exists();
  if (!exists) {
    context.warn(`Container "${containerName}" does not exist.`);
    return { ok: true, items: [] };
  }

  let sharedKeyCredential = null;
  if (!isPublic) {
    const parsed = parseConnectionString(connectionString);
    if (!parsed.accountName || !parsed.accountKey) {
      context.error(
        "Cannot generate SAS: AccountName/AccountKey not found in connection string."
      );
      return {
        ok: false,
        status: 500,
        error:
          "Cannot generate SAS URLs. Use a full storage connection string (with AccountKey) or set PUBLIC_CONTAINER=true.",
      };
    }
    sharedKeyCredential = new StorageSharedKeyCredential(
      parsed.accountName,
      parsed.accountKey
    );
  }

  // Pre-compute SAS validity window (start 5 min in the past for clock skew).
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + SAS_EXPIRY_HOURS * 60 * 60 * 1000);

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
        sharedKeyCredential
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
  parseConnectionString,
  listContainerBlobs,
};
