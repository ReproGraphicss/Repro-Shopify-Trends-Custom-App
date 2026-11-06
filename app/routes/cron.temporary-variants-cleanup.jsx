/* global process */
import { timingSafeEqual } from "node:crypto";
import prisma from "../db.server";
import { cleanupExpiredConfiguredVariants } from "../lib/temporary-variant.server";
import { unauthenticated } from "../shopify.server";

const LOG_RETENTION_LIMIT = 1000;
const LOG_RETENTION_BATCH = 500;
const LOG_MODES = ["prices", "full", "cleanup", "catalog"];

const pruneOldSyncLogs = async (shop) => {
  const deletedByMode = {};
  for (const mode of LOG_MODES) {
    let deleted = 0;
    let hasMore = true;
    while (hasMore) {
      const expiredLogs = await prisma.cronSyncLog.findMany({
        where: { shop, mode },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        skip: LOG_RETENTION_LIMIT,
        take: LOG_RETENTION_BATCH,
        select: { id: true },
      });
      if (!expiredLogs.length) break;
      const result = await prisma.cronSyncLog.deleteMany({
        where: { id: { in: expiredLogs.map(({ id }) => id) } },
      });
      deleted += result.count;
      hasMore = expiredLogs.length === LOG_RETENTION_BATCH;
    }
    deletedByMode[mode] = deleted;
  }
  return deletedByMode;
};

const authorized = (request) => {
  const expected = process.env.CRON_SECRET || "";
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    request.headers.get("x-cron-secret") ||
    "";
  if (!expected || expected.length !== supplied.length) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(expected), encoder.encode(supplied));
};

const handle = async (request) => {
  if (!authorized(request))
    return Response.json(
      { ok: false, message: "Unauthorized" },
      { status: 401 },
    );
  const startedAt = Date.now();
  const now = new Date();
  const [expiredShopRows, configuredShopRows, offlineSessionRows] =
    await Promise.all([
      prisma.temporaryConfiguredVariant.findMany({
        where: { expiresAt: { lte: now } },
        distinct: ["shop"],
        select: { shop: true },
      }),
      prisma.shopSettings.findMany({ select: { shop: true } }),
      prisma.session.findMany({
        where: { isOnline: false },
        distinct: ["shop"],
        select: { shop: true },
      }),
    ]);
  const connectedShops = new Set(offlineSessionRows.map(({ shop }) => shop));
  const expiredShops = new Set(
    expiredShopRows
      .map(({ shop }) => shop)
      .filter((shop) => connectedShops.has(shop)),
  );
  const shopNames = [
    ...new Set([
      ...configuredShopRows
        .map(({ shop }) => shop)
        .filter((shop) => connectedShops.has(shop)),
      ...expiredShops,
    ]),
  ];
  const logIds = new Map(
    await Promise.all(
      shopNames.map(async (shop) => {
        const log = await prisma.cronSyncLog.create({
          data: { shop, mode: "cleanup", status: "RUNNING" },
          select: { id: true },
        });
        return [shop, log.id];
      }),
    ),
  );
  const result = {
    ok: true,
    shops: expiredShops.size,
    expired: 0,
    variantsDeleted: 0,
    productsDeleted: 0,
    recordsRemoved: 0,
    logsDeleted: 0,
    errors: [],
  };
  for (const shop of shopNames) {
    const shopStartedAt = Date.now();
    const shopResult = {
      expired: expiredShops.has(shop)
        ? await prisma.temporaryConfiguredVariant.count({
            where: { shop, expiresAt: { lte: now } },
          })
        : 0,
      variantsDeleted: 0,
      productsDeleted: 0,
      recordsRemoved: 0,
      errors: [],
      items: [],
    };
    try {
      if (expiredShops.has(shop)) {
        const { admin } = await unauthenticated.admin(shop);
        Object.assign(
          shopResult,
          await cleanupExpiredConfiguredVariants({ admin, shop }),
        );
      }
    } catch (error) {
      shopResult.errors.push({
        message: error instanceof Error ? error.message : "Cleanup failed",
      });
    }
    result.expired += shopResult.expired;
    result.variantsDeleted += shopResult.variantsDeleted;
    result.productsDeleted += shopResult.productsDeleted;
    result.recordsRemoved += shopResult.recordsRemoved;
    result.errors.push(
      ...shopResult.errors.map((error) => ({ shop, ...error })),
    );
    try {
      const deletedByMode = await pruneOldSyncLogs(shop);
      const logsDeleted = Object.values(deletedByMode).reduce(
        (sum, count) => sum + count,
        0,
      );
      result.logsDeleted += logsDeleted;
      Object.entries(deletedByMode).forEach(([mode, count]) => {
        if (!count) return;
        shopResult.items.push({
          status: "success",
          title: `${mode} synchronization logs`,
          action: "old_sync_logs_deleted",
          logsDeleted: count,
          retained: LOG_RETENTION_LIMIT,
        });
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Log retention cleanup failed";
      shopResult.errors.push({ message });
      result.errors.push({ shop, message });
      shopResult.items.push({
        status: "failed",
        title: "Synchronization log retention",
        action: "log_cleanup_failed",
        message,
      });
    }
    const failed = shopResult.errors.length;
    const remaining = Math.max(
      0,
      shopResult.expired - shopResult.recordsRemoved,
    );
    await prisma.cronSyncLog.update({
      where: { id: logIds.get(shop) },
      data: {
        status:
          failed === 0
            ? "COMPLETED"
            : shopResult.recordsRemoved > 0
              ? "PARTIAL"
              : "FAILED",
        products: shopResult.expired,
        processed: shopResult.expired,
        updated: shopResult.recordsRemoved,
        failed,
        remaining,
        durationMs: Date.now() - shopStartedAt,
        errorsJson: JSON.stringify(shopResult.errors),
        detailsJson: JSON.stringify(shopResult.items || []),
        finishedAt: new Date(),
      },
    });
  }
  result.ok = result.errors.length === 0;
  result.durationMs = Date.now() - startedAt;
  return Response.json(result, { status: result.ok ? 200 : 207 });
};

export const loader = ({ request }) => handle(request);
export const action = ({ request }) => handle(request);
