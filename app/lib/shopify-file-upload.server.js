import crypto from "node:crypto";
import path from "node:path";

export const MAX_SHOPIFY_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_SHOPIFY_UPLOAD_FILES = 20;
export const ALLOWED_SHOPIFY_UPLOAD_EXTENSIONS = [
  ".pdf",
  ".svg",
  ".ai",
  ".eps",
  ".psd",
  ".jpg",
  ".jpeg",
  ".png",
  ".docx",
  ".webp",
];

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".ai": "application/postscript",
  ".eps": "application/postscript",
  ".psd": "image/vnd.adobe.photoshop",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".webp": "image/webp",
};

export class FileUploadError extends Error {
  constructor(message, { code = "UPLOAD_FAILED", status = 500, details } = {}) {
    super(message);
    this.name = "FileUploadError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const cleanFilename = (filename) => {
  const base = path.basename(String(filename || "")).trim();
  if (!base || base.startsWith(".")) {
    throw new FileUploadError("A valid filename is required", {
      code: "INVALID_FILENAME",
      status: 422,
    });
  }
  return base.replace(/[\u0000-\u001f\u007f]/g, "");
};

export const validateShopifyFile = (file) => {
  if (!(file instanceof File)) {
    throw new FileUploadError("Send the file using multipart field 'file'", {
      code: "FILE_REQUIRED",
      status: 400,
    });
  }

  const filename = cleanFilename(file.name);
  const extension = path.extname(filename).toLowerCase();
  if (!ALLOWED_SHOPIFY_UPLOAD_EXTENSIONS.includes(extension)) {
    throw new FileUploadError(
      "Unsupported file type. Allowed types: PDF, SVG, AI, EPS, PSD, JPG, JPEG, PNG, DOCX and WEBP",
      { code: "UNSUPPORTED_FILE_TYPE", status: 415 },
    );
  }
  if (!file.size) {
    throw new FileUploadError("The uploaded file is empty", {
      code: "EMPTY_FILE",
      status: 422,
    });
  }
  if (file.size > MAX_SHOPIFY_UPLOAD_BYTES) {
    throw new FileUploadError("File size must not exceed 20 MB", {
      code: "FILE_TOO_LARGE",
      status: 413,
      details: { maximumBytes: MAX_SHOPIFY_UPLOAD_BYTES },
    });
  }

  return { filename, extension, mimeType: MIME_TYPES[extension] };
};

const readGraphql = async (response, operation) => {
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new FileUploadError(`${operation} was rejected by Shopify`, {
      code: "SHOPIFY_GRAPHQL_ERROR",
      status: 502,
      details: payload.errors,
    });
  }
  return payload.data;
};

const throwUserErrors = (userErrors, operation) => {
  if (!userErrors?.length) return;
  throw new FileUploadError(
    userErrors.map((error) => error.message).join("; "),
    {
      code: "SHOPIFY_VALIDATION_ERROR",
      status: 422,
      details: { operation, errors: userErrors },
    },
  );
};

const createStagedTarget = async ({ admin, filename, mimeType, fileSize }) => {
  const response = await admin.graphql(
    `#graphql
      mutation CreateFileUploadTarget($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        input: [
          {
            filename,
            mimeType,
            fileSize: String(fileSize),
            httpMethod: "POST",
            resource: "FILE",
          },
        ],
      },
    },
  );
  const data = await readGraphql(response, "Staged upload creation");
  throwUserErrors(data?.stagedUploadsCreate?.userErrors, "stagedUploadsCreate");
  const target = data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new FileUploadError("Shopify did not return an upload destination", {
      code: "STAGED_TARGET_MISSING",
      status: 502,
    });
  }
  return target;
};

const sendToStagedTarget = async ({ target, file, filename, mimeType }) => {
  const form = new FormData();
  for (const parameter of target.parameters || []) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", file, filename);

  let response;
  try {
    response = await fetch(target.url, { method: "POST", body: form });
  } catch (error) {
    throw new FileUploadError("Could not send the file to Shopify", {
      code: "STAGED_UPLOAD_NETWORK_ERROR",
      status: 502,
      details: error instanceof Error ? error.message : undefined,
    });
  }
  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 1000);
    throw new FileUploadError("Shopify rejected the file upload", {
      code: "STAGED_UPLOAD_FAILED",
      status: 502,
      details: { status: response.status, response: responseText, mimeType },
    });
  }
};

const createShopifyFile = async ({ admin, resourceUrl, filename }) => {
  const response = await admin.graphql(
    `#graphql
      mutation CreateShopifyFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            alt
            ... on GenericFile { url mimeType originalFileSize }
            ... on MediaImage { image { url } }
          }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        files: [
          {
            originalSource: resourceUrl,
            contentType: "FILE",
            alt: filename,
          },
        ],
      },
    },
  );
  const data = await readGraphql(response, "Shopify file creation");
  throwUserErrors(data?.fileCreate?.userErrors, "fileCreate");
  const created = data?.fileCreate?.files?.[0];
  if (!created?.id) {
    throw new FileUploadError("Shopify did not create a file record", {
      code: "FILE_CREATE_FAILED",
      status: 502,
    });
  }
  return created;
};

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const readFileStatus = async (admin, id) => {
  const response = await admin.graphql(
    `#graphql
      query UploadedFileStatus($id: ID!) {
        node(id: $id) {
          ... on GenericFile {
            id
            fileStatus
            url
            mimeType
            originalFileSize
            fileErrors { code message }
          }
          ... on MediaImage {
            id
            fileStatus
            image { url }
            fileErrors { code message }
          }
        }
      }
    `,
    { variables: { id } },
  );
  const data = await readGraphql(response, "File status lookup");
  return data?.node;
};

const waitForCdnUrl = async (admin, initialFile) => {
  let current = initialFile;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const url = current?.url || current?.image?.url;
    if (current?.fileStatus === "READY" && url) return current;
    if (current?.fileStatus === "FAILED") {
      throw new FileUploadError("Shopify could not process the uploaded file", {
        code: "SHOPIFY_FILE_PROCESSING_FAILED",
        status: 422,
        details: current.fileErrors || [],
      });
    }
    await wait(attempt < 4 ? 350 : 750);
    current = await readFileStatus(admin, initialFile.id);
  }
  throw new FileUploadError("Shopify is still processing the file", {
    code: "SHOPIFY_FILE_PROCESSING_TIMEOUT",
    status: 504,
    details: { fileId: initialFile.id, fileStatus: current?.fileStatus },
  });
};

export const uploadFileToShopify = async ({ admin, file }) => {
  const { filename, extension, mimeType } = validateShopifyFile(file);
  const target = await createStagedTarget({
    admin,
    filename,
    mimeType,
    fileSize: file.size,
  });
  await sendToStagedTarget({ target, file, filename, mimeType });
  const created = await createShopifyFile({
    admin,
    resourceUrl: target.resourceUrl,
    filename,
  });
  const ready = await waitForCdnUrl(admin, created);

  return {
    id: ready.id,
    filename,
    extension: extension.slice(1),
    mimeType: ready.mimeType || mimeType,
    size: ready.originalFileSize || file.size,
    status: ready.fileStatus,
    cdnUrl: ready.url || ready.image?.url,
    uploadId: crypto.randomUUID(),
  };
};

export const uploadFilesToShopify = async ({ admin, files }) => {
  const validated = files.map((file) => ({
    file,
    metadata: validateShopifyFile(file),
  }));
  const uploaded = [];
  const failed = [];

  // Keep uploads sequential so large artwork files do not create avoidable
  // memory spikes or burst Shopify's Admin API limits.
  for (const item of validated) {
    try {
      uploaded.push(await uploadFileToShopify({ admin, file: item.file }));
    } catch (error) {
      failed.push({
        filename: item.metadata.filename,
        code: error instanceof FileUploadError ? error.code : "UPLOAD_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The file could not be uploaded",
        details:
          error instanceof FileUploadError ? error.details || null : null,
      });
    }
  }

  return { uploaded, failed };
};
