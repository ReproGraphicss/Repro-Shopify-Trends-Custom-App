import crypto from "node:crypto";

import {
  ALLOWED_SHOPIFY_UPLOAD_EXTENSIONS,
  FileUploadError,
  MAX_SHOPIFY_UPLOAD_BYTES,
  MAX_SHOPIFY_UPLOAD_FILES,
  uploadFilesToShopify,
} from "../lib/shopify-file-upload.server";
import { authenticate, unauthenticated } from "../shopify.server";

const response = (
  { success, code, message, data = null, errors = null },
  status,
) =>
  Response.json(
    {
      success,
      code,
      message,
      data,
      errors,
      meta: {
        requestId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      },
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    },
  );

const fail = (code, message, status, errors = null) =>
  response({ success: false, code, message, errors }, status);

const handle = async (request) => {
  if (request.method === "OPTIONS") {
    return response(
      { success: true, code: "OK", message: "Preflight accepted" },
      200,
    );
  }
  if (request.method !== "POST") {
    return fail("METHOD_NOT_ALLOWED", "Use POST for this endpoint", 405);
  }

  let session;
  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch {
    return fail("UNAUTHORIZED", "The upload request is not authorized", 401);
  }
  if (!session?.shop) {
    return fail("STORE_NOT_CONNECTED", "Store is not connected", 401);
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return fail(
        "INVALID_CONTENT_TYPE",
        "Use multipart/form-data and send the upload in the 'file' field",
        415,
      );
    }

    const form = await request.formData();
    const files = [...form.getAll("file"), ...form.getAll("files")].filter(
      (entry) => entry instanceof File,
    );
    if (!files.length) {
      return fail(
        "FILE_REQUIRED",
        "Send at least one file using the 'file' or 'files' field",
        400,
      );
    }
    if (files.length > MAX_SHOPIFY_UPLOAD_FILES) {
      return fail(
        "TOO_MANY_FILES",
        `A maximum of ${MAX_SHOPIFY_UPLOAD_FILES} files is allowed per request`,
        422,
      );
    }
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_SHOPIFY_UPLOAD_BYTES) {
      return fail(
        "REQUEST_TOO_LARGE",
        "Combined file size must not exceed 20 MB",
        413,
        { maximumBytes: MAX_SHOPIFY_UPLOAD_BYTES, receivedBytes: totalBytes },
      );
    }

    const { admin } = await unauthenticated.admin(session.shop);
    const result = await uploadFilesToShopify({ admin, files });
    const allUploaded = result.failed.length === 0;
    const noneUploaded = result.uploaded.length === 0;
    return response(
      {
        success: allUploaded,
        code: allUploaded
          ? files.length === 1
            ? "FILE_UPLOADED"
            : "FILES_UPLOADED"
          : noneUploaded
            ? "FILES_UPLOAD_FAILED"
            : "FILES_PARTIALLY_UPLOADED",
        message: allUploaded
          ? `${result.uploaded.length} file${result.uploaded.length === 1 ? "" : "s"} uploaded to Shopify Content successfully`
          : `${result.uploaded.length} of ${files.length} files uploaded successfully`,
        data: {
          file: files.length === 1 ? result.uploaded[0] || null : null,
          files: result.uploaded,
          failed: result.failed,
          summary: {
            requested: files.length,
            uploaded: result.uploaded.length,
            failed: result.failed.length,
          },
        },
        errors: result.failed.length ? result.failed : null,
      },
      allUploaded ? 201 : noneUploaded ? 422 : 207,
    );
  } catch (error) {
    if (error instanceof FileUploadError) {
      return fail(
        error.code,
        error.message,
        error.status,
        error.details || null,
      );
    }
    return fail(
      "INTERNAL_ERROR",
      "The file could not be uploaded",
      500,
      process.env.NODE_ENV === "development" && error instanceof Error
        ? { message: error.message }
        : null,
    );
  }
};

export const action = ({ request }) => handle(request);

export const loader = () =>
  response(
    {
      success: true,
      code: "FILE_UPLOAD_API",
      message: "Send files using POST multipart/form-data",
      data: {
        fields: ["file", "files"],
        maximumFiles: MAX_SHOPIFY_UPLOAD_FILES,
        maximumBytes: MAX_SHOPIFY_UPLOAD_BYTES,
        maximumMegabytes: 20,
        limitAppliesTo: "combined request file size",
        allowedExtensions: ALLOWED_SHOPIFY_UPLOAD_EXTENSIONS.map((value) =>
          value.slice(1),
        ),
      },
    },
    200,
  );
