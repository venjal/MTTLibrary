// =========================================================================
//  library — HTTP-triggered Azure Function (Node.js programming model v4)
//  Route:  GET /api/library
//
//  Lists blobs across the two trainer content families — "ai" and
//  "copilot" — for both the videos and ebooks containers. Category is
//  derived entirely from blob folder prefixes (videos/ai/, videos/copilot/,
//  ebooks/ai/, ebooks/copilot/) — no filename prefixes or hardcoded
//  names/counts are used anywhere. A trainer drops a file into the right
//  folder in blob storage and it shows up on the next page load.
//
//  Response shape:
//  {
//    "ai":      { "videos": [ {title, filename, sizeMB, modified, url}, ... ],
//                 "ebooks": [ ... ] },
//    "copilot": { "videos": [ ... ], "ebooks": [ ... ] }
//  }
//
//  App settings used:
//    AZURE_STORAGE_CONNECTION_STRING  (required) storage connection string
//    VIDEOS_CONTAINER                 (optional) container name, default "videos"
//    EBOOKS_CONTAINER                 (optional) container name, default "ebooks"
//    PUBLIC_CONTAINER                 (optional) "true" => direct blob URLs
// =========================================================================

const { app } = require("@azure/functions");
const { listContainerBlobs } = require("../lib/blobUtils");

const CATEGORIES = ["ai", "copilot"];

app.http("library", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "library",
  handler: async (request, context) => {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const videosContainer = process.env.VIDEOS_CONTAINER || "videos";
    const ebooksContainer = process.env.EBOOKS_CONTAINER || "ebooks";
    const isPublic =
      (process.env.PUBLIC_CONTAINER || "").toLowerCase() === "true";

    try {
      const result = {};

      for (const category of CATEGORIES) {
        const [videosResult, ebooksResult] = await Promise.all([
          listContainerBlobs({
            connectionString,
            containerName: videosContainer,
            isPublic,
            extensionRegex: /\.mp4$/i,
            prefix: `${category}/`,
            context,
          }),
          listContainerBlobs({
            connectionString,
            containerName: ebooksContainer,
            isPublic,
            extensionRegex: /\.html?$/i,
            prefix: `${category}/`,
            context,
          }),
        ]);

        if (!videosResult.ok) {
          return { status: videosResult.status, jsonBody: { error: videosResult.error } };
        }
        if (!ebooksResult.ok) {
          return { status: ebooksResult.status, jsonBody: { error: ebooksResult.error } };
        }

        result[category] = {
          videos: videosResult.items,
          ebooks: ebooksResult.items,
        };
      }

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Don't cache SAS URLs at the edge; they expire.
          "Cache-Control": "no-store",
        },
        jsonBody: result,
      };
    } catch (err) {
      context.error("Failed to list trainer library:", err);
      return {
        status: 500,
        jsonBody: {
          error: "Failed to list trainer library from storage.",
          detail: err && err.message ? err.message : String(err),
        },
      };
    }
  },
});
