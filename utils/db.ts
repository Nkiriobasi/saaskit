// Copyright 2023 the Deno authors. All rights reserved. MIT license.
import { chunk } from "std/collections/chunk.ts";

const KV_PATH_KEY = "KV_PATH";
let path = undefined;
if (
  (await Deno.permissions.query({ name: "env", variable: KV_PATH_KEY }))
    .state === "granted"
) {
  path = Deno.env.get(KV_PATH_KEY);
}
export const kv = await Deno.openKv(path);

// Helpers
async function getValue<T>(
  key: Deno.KvKey,
  options?: { consistency?: Deno.KvConsistencyLevel },
) {
  const res = await kv.get<T>(key, options);
  return res.value;
}

/**
 * Gets many values from KV. Uses batched requests to get values in chunks of 10.
 */
async function getManyValues<T>(
  keys: Deno.KvKey[],
): Promise<(T | null)[]> {
  const promises = [];
  for (const batch of chunk(keys, 10)) {
    promises.push(kv.getMany<T[]>(batch));
  }
  return (await Promise.all(promises))
    .flat()
    .map((entry) => entry?.value);
}

/** Gets all dates since a given number of milliseconds ago */
export function getDatesSince(msAgo: number) {
  const dates = [];
  const now = Date.now();
  const start = new Date(now - msAgo);

  while (+start < now) {
    start.setDate(start.getDate() + 1);
    dates.push(formatDate(new Date(start)));
  }

  return dates;
}

export async function collectValues<T>(iter: Deno.KvListIterator<T>) {
  const values = [];
  for await (const { value } of iter) values.push(value);
  return values;
}

/** Converts `Date` to ISO format that is zero UTC offset */
export function formatDate(date: Date) {
  return date.toISOString().split("T")[0];
}

// Item
export interface Item {
  userLogin: string;
  title: string;
  url: string;
  // The below properties can be automatically generated upon item creation
  id: string;
  createdAt: Date;
  score: number;
}

export function newItemProps(): Pick<Item, "id" | "score" | "createdAt"> {
  return {
    id: crypto.randomUUID(),
    score: 0,
    createdAt: new Date(),
  };
}

/**
 * Creates a new item in KV. Throws if the item already exists in one of the indexes.
 *
 * @example
 * ```ts
 * import { newItemProps, createItem } from "@/utils/db.ts";
 *
 * await createItem({
 *   userLogin: "john_doe",
 *   title: "example-title",
 *   url: "https://example.com",
 *   ...newItemProps(),
 * });
 * ```
 */
export async function createItem(item: Item) {
  const itemsKey = ["items", item.id];
  const itemsByTimeKey = ["items_by_time", item.createdAt.getTime(), item.id];
  const itemsByUserKey = ["items_by_user", item.userLogin, item.id];
  const itemsCountKey = ["items_count", formatDate(item.createdAt)];

  const res = await kv.atomic()
    .check({ key: itemsKey, versionstamp: null })
    .check({ key: itemsByTimeKey, versionstamp: null })
    .check({ key: itemsByUserKey, versionstamp: null })
    .set(itemsKey, item)
    .set(itemsByTimeKey, item)
    .set(itemsByUserKey, item)
    .sum(itemsCountKey, 1n)
    .commit();

  if (!res.ok) throw new Error(`Failed to create item: ${item}`);
}

export async function deleteItem(item: Item) {
  const itemsKey = ["items", item.id];
  const itemsByTimeKey = ["items_by_time", item.createdAt.getTime(), item.id];
  const itemsByUserKey = ["items_by_user", item.userLogin, item.id];

  const res = await kv.atomic()
    .delete(itemsKey)
    .delete(itemsByTimeKey)
    .delete(itemsByUserKey)
    .commit();

  if (!res.ok) throw new Error(`Failed to delete item: ${item}`);
}

export async function getItem(id: string) {
  return await getValue<Item>(["items", id]);
}

export function listItemsByUser(
  userLogin: string,
  options?: Deno.KvListOptions,
) {
  return kv.list<Item>({ prefix: ["items_by_user", userLogin] }, options);
}

export function listItemsByTime(options?: Deno.KvListOptions) {
  return kv.list<Item>({ prefix: ["items_by_time"] }, options);
}

// Notification
export interface Notification {
  // Uses ULID
  id: string;
  userLogin: string;
  type: string;
  text: string;
  originUrl: string;
}

/**
 * Creates a new notification in KV. Throws if the item already exists in one of the indexes.
 *
 * @example
 * ```ts
 * import { createNotification } from "@/utils/db.ts";
 * import { monotonicUlid } from "std/ulid/mod.ts";
 *
 * await createNotification({
 *   id: monotonicUlid(),
 *   userLogin: "john_doe",
 *   type: "example-type",
 *   text: "Hello, world!",
 *   originUrl: "https://hunt.deno.land",
 * });
 * ```
 */
export async function createNotification(notification: Notification) {
  const key = [
    "notifications_by_user",
    notification.userLogin,
    notification.id,
  ];

  const res = await kv.atomic()
    .check({ key: key, versionstamp: null })
    .set(key, notification)
    .commit();

  if (!res.ok) throw new Error("Failed to create notification");
}

export async function deleteNotification(
  notification: Pick<Notification, "id" | "userLogin">,
) {
  const key = [
    "notifications_by_user",
    notification.userLogin,
    notification.id,
  ];
  const notificationRes = await kv.get<Notification>(key);
  if (notificationRes.value === null) {
    throw new Deno.errors.NotFound("Notification not found");
  }

  const res = await kv.atomic()
    .check(notificationRes)
    .delete(key)
    .commit();

  if (!res.ok) throw new Error("Failed to delete notification");
}

export async function getNotification(
  notification: Pick<Notification, "id" | "userLogin">,
) {
  return await getValue<Notification>([
    "notifications_by_user",
    notification.userLogin,
    notification.id,
  ]);
}

export function listNotifications(
  userLogin: string,
  options?: Deno.KvListOptions,
) {
  return kv.list<Notification>({
    prefix: ["notifications_by_user", userLogin],
  }, options);
}

export async function ifUserHasNotifications(userLogin: string) {
  const iter = kv.list({ prefix: ["notifications_by_user", userLogin] }, {
    consistency: "eventual",
  });
  for await (const _entry of iter) return true;
  return false;
}

// Comment
export interface Comment {
  userLogin: string;
  itemId: string;
  text: string;
  // The below properties can be automatically generated upon comment creation
  id: string;
  createdAt: Date;
}

export function newCommentProps(): Pick<Comment, "id" | "createdAt"> {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(),
  };
}

export async function createComment(comment: Comment) {
  const commentsByItemKey = [
    "comments_by_item",
    comment.itemId,
    comment.createdAt.getTime(),
    comment.id,
  ];

  const res = await kv.atomic()
    .check({ key: commentsByItemKey, versionstamp: null })
    .set(commentsByItemKey, comment)
    .commit();

  if (!res.ok) throw new Error(`Failed to create comment: ${comment}`);
}

export async function deleteComment(comment: Comment) {
  const commentsByItemKey = [
    "comments_by_item",
    comment.itemId,
    comment.createdAt.getTime(),
    comment.id,
  ];

  const res = await kv.atomic()
    .delete(commentsByItemKey)
    .commit();

  if (!res.ok) throw new Error(`Failed to delete comment: ${comment}`);
}

export function listCommentsByItem(
  itemId: string,
  options?: Deno.KvListOptions,
) {
  return kv.list<Comment>({ prefix: ["comments_by_item", itemId] }, options);
}

// Vote
export interface Vote {
  itemId: string;
  userLogin: string;
  // The below property can be automatically generated upon vote creation
  createdAt: Date;
}

export function newVoteProps(): Pick<Vote, "createdAt"> {
  return {
    createdAt: new Date(),
  };
}

export async function createVote(vote: Vote) {
  const itemKey = ["items", vote.itemId];
  const userKey = ["users", vote.userLogin];
  const [itemRes, userRes] = await kv.getMany<[Item, User]>([itemKey, userKey]);
  const item = itemRes.value;
  const user = userRes.value;
  if (item === null) throw new Deno.errors.NotFound("Item not found");
  if (user === null) throw new Deno.errors.NotFound("User not found");

  const itemVotedByUserKey = [
    "items_voted_by_user",
    vote.userLogin,
    vote.itemId,
  ];
  const userVotedForItemKey = [
    "users_voted_for_item",
    vote.itemId,
    vote.userLogin,
  ];
  const itemByTimeKey = ["items_by_time", item.createdAt.getTime(), item.id];
  const itemByUserKey = ["items_by_user", item.userLogin, item.id];
  const votesCountKey = ["votes_count", formatDate(vote.createdAt)];

  item.score++;

  const res = await kv.atomic()
    .check(itemRes)
    .check(userRes)
    .check({ key: itemVotedByUserKey, versionstamp: null })
    .check({ key: userVotedForItemKey, versionstamp: null })
    .set(itemKey, item)
    .set(itemByTimeKey, item)
    .set(itemByUserKey, item)
    .set(itemVotedByUserKey, item)
    .set(userVotedForItemKey, user)
    .sum(votesCountKey, 1n)
    .commit();

  if (!res.ok) throw new Error("Failed to set vote", { cause: vote });
}

export async function deleteVote(vote: Omit<Vote, "createdAt">) {
  const itemKey = ["items", vote.itemId];
  const userKey = ["users", vote.userLogin];
  const itemVotedByUserKey = [
    "items_voted_by_user",
    vote.userLogin,
    vote.itemId,
  ];
  const userVotedForItemKey = [
    "users_voted_for_item",
    vote.itemId,
    vote.userLogin,
  ];
  const [itemRes, userRes, itemVotedByUserRes, userVotedForItemRes] = await kv
    .getMany<
      [Item, User, Item, User]
    >([itemKey, userKey, itemVotedByUserKey, userVotedForItemKey]);
  const item = itemRes.value;
  const user = userRes.value;
  if (item === null) throw new Deno.errors.NotFound("Item not found");
  if (user === null) throw new Deno.errors.NotFound("User not found");
  if (itemVotedByUserRes.value === null) {
    throw new Deno.errors.NotFound("Item voted by user not found");
  }
  if (userVotedForItemRes.value === null) {
    throw new Deno.errors.NotFound("User voted for item not found");
  }

  const itemByTimeKey = ["items_by_time", item.createdAt.getTime(), item.id];
  const itemByUserKey = ["items_by_user", item.userLogin, item.id];

  item.score--;

  const res = await kv.atomic()
    .check(itemRes)
    .check(userRes)
    .check(itemVotedByUserRes)
    .check(userVotedForItemRes)
    .set(itemKey, item)
    .set(itemByTimeKey, item)
    .set(itemByUserKey, item)
    .delete(itemVotedByUserKey)
    .delete(userVotedForItemKey)
    .commit();

  if (!res.ok) throw new Error("Failed to delete vote");
}

export function listItemsVotedByUser(userLogin: string) {
  return kv.list<Item>({ prefix: ["items_voted_by_user", userLogin] });
}

// User
export interface User {
  // AKA username
  login: string;
  sessionId: string;
  stripeCustomerId?: string;
  // The below properties can be automatically generated upon comment creation
  isSubscribed: boolean;
}

export function newUserProps(): Pick<User, "isSubscribed"> {
  return {
    isSubscribed: false,
  };
}

/**
 * Creates a new user in KV. Throws if the user already exists.
 *
 * @example
 * ```ts
 * import { createUser, newUserProps } from "@/utils/db.ts";
 *
 * await createUser({
 *   login: "john-doe",
 *   sessionId: crypto.randomUUID(),
 *   ...newUserProps(),
 * });
 * ```
 */
export async function createUser(user: User) {
  const usersKey = ["users", user.login];
  const usersBySessionKey = ["users_by_session", user.sessionId];
  const usersCountKey = ["users_count", formatDate(new Date())];

  const atomicOp = kv.atomic();

  if (user.stripeCustomerId !== undefined) {
    const usersByStripeCustomerKey = [
      "users_by_stripe_customer",
      user.stripeCustomerId,
    ];
    atomicOp
      .check({ key: usersByStripeCustomerKey, versionstamp: null })
      .set(usersByStripeCustomerKey, user);
  }

  const res = await atomicOp
    .check({ key: usersKey, versionstamp: null })
    .check({ key: usersBySessionKey, versionstamp: null })
    .set(usersKey, user)
    .set(usersBySessionKey, user)
    .sum(usersCountKey, 1n)
    .commit();

  if (!res.ok) throw new Error(`Failed to create user: ${user}`);
}

export async function updateUser(user: User) {
  const usersKey = ["users", user.login];
  const usersBySessionKey = ["users_by_session", user.sessionId];

  const atomicOp = kv.atomic();

  if (user.stripeCustomerId !== undefined) {
    const usersByStripeCustomerKey = [
      "users_by_stripe_customer",
      user.stripeCustomerId,
    ];
    atomicOp
      .set(usersByStripeCustomerKey, user);
  }

  const res = await atomicOp
    .set(usersKey, user)
    .set(usersBySessionKey, user)
    .commit();

  if (!res.ok) throw new Error(`Failed to update user: ${user}`);
}

export async function deleteUserBySession(sessionId: string) {
  await kv.delete(["users_by_session", sessionId]);
}

/** @todo Migrate to ["users", login] key */
export async function getUser(login: string) {
  return await getValue<User>(["users", login]);
}

export async function getUserBySession(sessionId: string) {
  const usersBySessionKey = ["users_by_session", sessionId];
  return await getValue<User>(usersBySessionKey, {
    consistency: "eventual",
  }) ?? await getValue<User>(usersBySessionKey);
}

export async function getUserByStripeCustomer(stripeCustomerId: string) {
  return await getValue<User>([
    "users_by_stripe_customer",
    stripeCustomerId,
  ]);
}

export function listUsers(options?: Deno.KvListOptions) {
  return kv.list<User>({ prefix: ["users"] }, options);
}

export async function getAreVotedByUser(items: Item[], userLogin: string) {
  const votedItems = await collectValues(listItemsVotedByUser(userLogin));
  const votedItemsIds = votedItems.map((item) => item.id);
  return items.map((item) => votedItemsIds.includes(item.id));
}

export function compareScore(a: Item, b: Item) {
  return Number(b.score) - Number(a.score);
}

// Analytics
export async function incrVisitsCountByDay(date: Date) {
  const visitsKey = ["visits_count", formatDate(date)];
  await kv.atomic()
    .sum(visitsKey, 1n)
    .commit();
}

export async function getManyMetrics(
  metric: "visits_count" | "items_count" | "votes_count" | "users_count",
  dates: Date[],
) {
  const keys = dates.map((date) => [metric, formatDate(date)]);
  const res = await getManyValues<bigint>(keys);
  return res.map((value) => value?.valueOf() ?? 0n);
}
