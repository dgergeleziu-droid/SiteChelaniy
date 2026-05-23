import { getStore } from "@netlify/blobs";

const BLOB_KEY = "state";
const STORE_NAME = "wish-service";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Wish-Key",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, PUT, OPTIONS",
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function checkAuth(request) {
  const secret = process.env.WISH_SYNC_KEY;
  if (!secret) return null;
  const key = request.headers.get("x-wish-key");
  if (key !== secret) return json(401, { error: "Неверный ключ доступа" });
  return null;
}

async function loadState(store) {
  const data = await store.get(BLOB_KEY, { type: "json" });
  if (data && Array.isArray(data.wishes)) return data;
  return { wishes: [], version: 0, updatedAt: null };
}

async function saveState(store, state) {
  state.version = (state.version || 0) + 1;
  state.updatedAt = new Date().toISOString();
  await store.setJSON(BLOB_KEY, state);
  return state;
}

async function parseBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: corsHeaders,
    });
  }

  const authError = checkAuth(request);
  if (authError) return authError;

  const store = getStore({ name: STORE_NAME, consistency: "strong" });

  try {
    if (request.method === "GET") {
      const state = await loadState(store);
      return json(200, state);
    }

    const body = await parseBody(request);
    if (body === null) {
      return json(400, { error: "Некорректный JSON" });
    }

    const state = await loadState(store);

    if (request.method === "POST") {
      const wish = body.wish;
      if (!wish || !wish.id || !wish.title) {
        return json(400, { error: "Нужны поля wish.id и wish.title" });
      }
      if (state.wishes.some((w) => w.id === wish.id)) {
        return json(409, { error: "Заказ уже существует" });
      }
      state.wishes.unshift(wish);
      const saved = await saveState(store, state);
      return json(201, saved);
    }

    if (request.method === "PATCH") {
      const { id, patch } = body;
      if (!id || !patch) return json(400, { error: "Нужны id и patch" });
      const idx = state.wishes.findIndex((w) => w.id === id);
      if (idx === -1) return json(404, { error: "Заказ не найден" });
      state.wishes[idx] = { ...state.wishes[idx], ...patch };
      const saved = await saveState(store, state);
      return json(200, saved);
    }

    if (request.method === "DELETE") {
      const { id } = body;
      if (!id) return json(400, { error: "Нужен id" });
      const before = state.wishes.length;
      state.wishes = state.wishes.filter((w) => w.id !== id);
      if (state.wishes.length === before) return json(404, { error: "Заказ не найден" });
      const saved = await saveState(store, state);
      return json(200, saved);
    }

    if (request.method === "PUT") {
      if (!Array.isArray(body.wishes)) {
        return json(400, { error: "Нужен массив wishes" });
      }
      state.wishes = body.wishes;
      const saved = await saveState(store, state);
      return json(200, saved);
    }

    return json(405, { error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    return json(500, { error: "Ошибка сервера", message: err.message });
  }
};
