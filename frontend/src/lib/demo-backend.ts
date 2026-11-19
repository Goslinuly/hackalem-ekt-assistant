// Static demo backend for GitHub Pages (NEXT_PUBLIC_DEMO_MODE=1).
//
// There is no server and no LLM in the demo. Catalog data, alternatives and a few assistant
// answers were exported from the real FastAPI backend (scripts/export_demo_data.py). Everything
// else is answered by a small deterministic port of the backend's no-LLM grounded path:
// article lookup, catalog search, analogs for out-of-stock items, purchase terms and a cart
// proposal that changes the cart only after an explicit confirmation.
import type { AssistantOutput, Cart, CartLine, Category, Message, Product, Proposal, Turn } from "./api";

type Alternatives = { ids: number[]; reasons: Record<string, string>; warnings: string[] };
type RecordedOutput = Omit<AssistantOutput, "products"> & { products: number[] };
type DemoData = {
  capabilities: Record<string, string>;
  categories: { items: Category[]; coverage: "partial" };
  products: Product[];
  alternatives: Record<string, Alternatives>;
  recorded: Record<string, RecordedOutput>;
};
type StoredTurn = Turn & { ready_at: number };
type DemoState = {
  conversations: Record<string, { messages: Message[]; turns: StoredTurn[]; reference: number | null; proposal: string | null; language: Lang }>;
  proposals: Record<string, Proposal>;
  cart: Cart;
};
type Lang = "ru" | "kk" | "en";

export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const STATE_KEY = "ekt_demo_state_v1";
const PROPOSAL_TTL = 15 * 60;

let dataPromise: Promise<DemoData> | null = null;
let byId = new Map<number, Product>();

function rewriteUrl(url: string | null): string | null {
  if (!url) return url;
  if (url.startsWith("/api/v1/product-images/")) return `${BASE_PATH}/demo/images/${url.split("/").pop()}`;
  if (url.startsWith("/api/v1/certificates/")) return `${BASE_PATH}/demo/certificates/${url.split("/").pop()}`;
  return url;
}

function loadData(): Promise<DemoData> {
  if (!dataPromise) dataPromise = fetch(`${BASE_PATH}/demo/data.json`).then(r => r.json()).then((data: DemoData) => {
    for (const product of data.products) {
      product.image_url = rewriteUrl(product.image_url);
      product.certificates = product.certificates.map(c => ({ ...c, url: rewriteUrl(c.url) || c.url }));
    }
    byId = new Map(data.products.map(p => [p.id, p]));
    return data;
  });
  return dataPromise;
}

function emptyState(): DemoState {
  return { conversations: {}, proposals: {}, cart: { mode: "demo", version: 0, items: [], total_amount: "0", currency: "KZT" } };
}
function readState(): DemoState {
  try { const raw = sessionStorage.getItem(STATE_KEY); if (raw) return JSON.parse(raw) as DemoState; } catch { /* Storage may be disabled. */ }
  return memoryState;
}
let memoryState = emptyState();
function writeState(state: DemoState) {
  memoryState = state;
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* Keep the in-memory copy. */ }
}

const now = () => Date.now() / 1000;
const uid = () => crypto.randomUUID().replaceAll("-", "");
const fold = (value: string) => value.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");
const amount = (value: number) => String(Math.round(value * 100) / 100);

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { request_id: `demo-${uid().slice(0, 12)}`, warnings: [] } }), { status, headers: { "content-type": "application/json" } });
}
function fail(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { code, message, retryable: false }, meta: { request_id: `demo-${uid().slice(0, 12)}`, warnings: [] } }), { status, headers: { "content-type": "application/json" } });
}

// ---------- Catalog ----------

const STOP = new Set(["найди", "найти", "нужен", "нужна", "нужно", "нужны", "мне", "покажи", "подбери", "есть", "ли", "для", "и", "в", "на", "с", "по", "какой", "какие", "find", "show", "me", "need", "a", "the", "for", "please", "шт", "купить", "добавь", "хочу", "дана"]);
const IDENTIFIER = /^[\p{L}\d][\p{L}\d._/-]{3,}$/u;

function identifierCandidates(text: string): string[] {
  return text.split(/[\s|;,]+/).map(t => t.replace(/^[,;:"'«»()]+|[,;:"'«»()?!.]+$/g, "")).filter(t => IDENTIFIER.test(t) && /\d/.test(t) && /^\d{5,}_?$|^\d{6,}/.test(t));
}

function normalizeQuery(text: string): string {
  return fold(text).replace(/(\d+(?:[.,]\d+)?)\s*(?:ампер\w*|amp\w*|а\b|a\b)/g, "$1а").replace(/(\d+)\s*(?:вт\b|w\b)/g, "$1w").replace(/(\d+)\s*p\b/g, "$1p");
}

function haystack(p: Product): string {
  return normalizeQuery([p.article_original, p.name, p.brand || "", ...p.attributes.map(a => a.value || "")].join(" ")).replace(/\s+/g, " ");
}

function search(products: Product[], text: string, limit: number): Product[] {
  const ids = identifierCandidates(text);
  if (ids.length) {
    const wanted = new Set(ids.map(id => id.replace(/_$/, "")));
    const exact = products.filter(p => wanted.has(p.article_original.replace(/_$/, "")) || wanted.has(String(p.id)));
    if (exact.length) return exact.slice(0, limit);
  }
  const tokens = normalizeQuery(text).split(/[^\p{L}\d.,]+/u).filter(t => t.length > 1 && !STOP.has(t));
  if (!tokens.length) return [];
  const scored = products.map(p => {
    const hay = haystack(p);
    const score = tokens.reduce((sum, t) => sum + (hay.includes(t) ? 1 : t.length > 4 && hay.includes(t.slice(0, -2)) ? 0.6 : 0), 0);
    return { p, score };
  }).filter(x => x.score >= Math.max(1, Math.ceil(tokens.length * 0.6)));
  scored.sort((a, b) => b.score - a.score || Number(b.p.stock_status === "available") - Number(a.p.stock_status === "available"));
  return scored.slice(0, limit).map(x => x.p);
}

function browse(data: DemoData, q: URLSearchParams) {
  const query = q.get("query") || "", category = q.get("category") || "", brand = q.get("brand") || "";
  const stockOnly = q.get("stock_only") === "true";
  const min = q.get("min_price") ? Number(q.get("min_price")) : null, max = q.get("max_price") ? Number(q.get("max_price")) : null;
  const sort = q.get("sort") || "relevance";
  const page = Math.max(1, Number(q.get("page") || 1)), size = Math.min(24, Math.max(1, Number(q.get("page_size") || 12)));
  let items = query ? search(data.products, query, 1000) : [...data.products];
  if (category) items = items.filter(p => (p.category_path || []).join("/").startsWith(category));
  const brands = [...new Set(items.map(p => p.brand).filter((b): b is string => Boolean(b)))].sort();
  if (brand) items = items.filter(p => p.brand === brand);
  if (stockOnly) items = items.filter(p => p.stock_status === "available");
  if (min !== null) items = items.filter(p => p.price_amount !== null && Number(p.price_amount) >= min);
  if (max !== null) items = items.filter(p => p.price_amount !== null && Number(p.price_amount) <= max);
  const price = (p: Product) => p.price_amount === null ? Infinity : Number(p.price_amount);
  if (sort === "price_asc") items.sort((a, b) => price(a) - price(b));
  if (sort === "price_desc") items.sort((a, b) => (price(b) === Infinity ? -1 : price(b)) - (price(a) === Infinity ? -1 : price(a)));
  if (sort === "name") items.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const total = items.length;
  return { items: items.slice((page - 1) * size, page * size), total, page, page_size: size, pages: Math.ceil(total / size), brands, coverage: "partial", warnings: ["synthetic_demo_data", "catalog_coverage_is_partial_or_unknown"] };
}

// ---------- Cart ----------

function lines(items: { product_id: number; quantity: number }[]): CartLine[] {
  return items.map(i => {
    const p = byId.get(i.product_id);
    if (!p || p.price_amount === null) throw new Error("not_found");
    return { product_id: p.id, quantity: i.quantity, article_original: p.article_original, name: p.name, unit_price_amount: p.price_amount, line_total_amount: amount(Number(p.price_amount) * i.quantity) };
  });
}

function propose(state: DemoState, items: { product_id: number; quantity: number }[]): Proposal | string {
  for (const item of items) {
    const p = byId.get(item.product_id);
    if (!p) return "Товар не найден.";
    if (p.stock_status !== "available" || p.price_amount === null) return `${p.article_original}: товара нет в наличии.`;
    const inCart = state.cart.items.find(l => l.product_id === p.id)?.quantity || 0;
    if (item.quantity + inCart > Number(p.sellable_quantity || 0)) return `${p.article_original}: запрошено больше, чем есть в наличии (${p.sellable_quantity} шт с учётом корзины).`;
  }
  const items_ = lines(items);
  const proposal: Proposal = { id: uid(), version: 1, status: "proposed", mode: "demo", items: items_, total_amount: amount(items_.reduce((s, l) => s + Number(l.line_total_amount), 0)), currency: "KZT", cart_version: state.cart.version, expires_at: now() + PROPOSAL_TTL, receipt_id: null, cart_url: null };
  state.proposals[proposal.id] = proposal;
  return proposal;
}

function confirm(state: DemoState, id: string): Proposal | null {
  const proposal = state.proposals[id];
  if (!proposal) return null;
  if (proposal.status !== "proposed") return proposal;
  if (proposal.expires_at < now()) { proposal.status = "expired"; return proposal; }
  if (proposal.cart_version !== state.cart.version) { proposal.status = "stale"; return proposal; }
  const merged = new Map(state.cart.items.map(l => [l.product_id, l.quantity]));
  for (const line of proposal.items) merged.set(line.product_id, (merged.get(line.product_id) || 0) + line.quantity);
  const items = lines([...merged].map(([product_id, quantity]) => ({ product_id, quantity })));
  state.cart = { ...state.cart, version: state.cart.version + 1, items, total_amount: amount(items.reduce((s, l) => s + Number(l.line_total_amount), 0)) };
  proposal.status = "applied";
  proposal.receipt_id = uid();
  proposal.cart_url = `${BASE_PATH}/`;
  return proposal;
}

// ---------- Assistant (deterministic port of the backend's no-LLM path) ----------

const TEXT: Record<Lang, Record<string, string>> = {
  ru: {
    unknown: "Неизвестно", stock: "Остаток", price: "Цена", none: "В доступной выборке товар не найден. Это не означает, что его нет во всём магазине.",
    partial: "Поиск выполнен по доступной выборке каталога; полнота не гарантируется.", cert: "Сертификат", nocert: "Сертификат в доступных данных не указан.",
    alt: "Кандидаты на замену", noalt: "Подтверждённый аналог не найден: не хватает данных или параметры не совпадают.",
    draft: "Предложение подготовлено. Корзина не изменена. Проверьте состав, количество и сумму; подтвердите кнопкой или отдельным сообщением «да, добавь».",
    quantity: "Уточните точный артикул и количество каждой позиции. Корзина не изменена.", applied: "Товары добавлены в корзину после вашего подтверждения.",
    inactive: "Предложение больше не активно. Нужно проверить данные и создать новое.", rejected: "Предложение отклонено. Корзина не изменена.",
    noprop: "Нет показанного предложения для подтверждения. Сначала выберите товар и количество.",
    demo: "Демонстрационные данные: цены, остатки и корзина не относятся к реальному заказу EKT.",
    manager: "Для сложного подбора обратитесь к менеджеру через раздел «Контакты» сайта. Сообщение менеджеру автоматически не отправляется.",
    clarify: "Для какого товара? Укажите артикул или выберите одну карточку, чтобы я подобрал аналоги или уточнил характеристики.",
    files: "В демо-версии на GitHub Pages загрузка файлов отключена. Запустите проект локально, чтобы проверить разбор спецификаций.",
  },
  kk: {
    unknown: "Белгісіз", stock: "Қалдық", price: "Бағасы", none: "Қолжетімді каталогтан тауар табылмады. Бұл бүкіл дүкенде тауар жоқ дегенді білдірмейді.",
    partial: "Іздеу каталогтың қолжетімді бөлігінде орындалды; толықтығына кепілдік жоқ.", cert: "Сертификат", nocert: "Қолжетімді деректерде сертификат көрсетілмеген.",
    alt: "Баламалар", noalt: "Расталған балама табылмады: деректер жеткіліксіз немесе параметрлер сәйкес емес.",
    draft: "Ұсыныс дайын. Себет өзгерген жоқ. Тізімді, санын және сомасын тексеріп, батырмамен немесе «иә, қос» деп растаңыз.",
    quantity: "Әр тауардың нақты артикулы мен санын көрсетіңіз. Себет өзгерген жоқ.", applied: "Растауыңыздан кейін тауарлар себетке қосылды.",
    inactive: "Ұсыныс белсенді емес. Деректерді тексеріп, жаңасын жасау керек.", rejected: "Ұсыныс қабылданбады. Себет өзгерген жоқ.",
    noprop: "Растайтын көрсетілген ұсыныс жоқ. Алдымен тауар мен санын таңдаңыз.",
    demo: "Демонстрациялық деректер: бағалар, қалдықтар және себет нақты EKT тапсырысы емес.",
    manager: "Күрделі таңдау үшін сайттың «Байланыс» бөлімі арқылы менеджерге жүгініңіз. Хабарлама автоматты түрде жіберілмейді.",
    clarify: "Қай тауар үшін? Артикулды көрсетіңіз немесе бір тауарды таңдаңыз.",
    files: "GitHub Pages демо-нұсқасында файл жүктеу өшірілген.",
  },
  en: {
    unknown: "Unknown", stock: "Available quantity", price: "Price", none: "No match in the available catalog subset. This does not establish absence from the whole store.",
    partial: "Search covers the available catalog subset; completeness is not guaranteed.", cert: "Certificate", nocert: "No certificate is listed in the available data.",
    alt: "Replacement candidates", noalt: "No verified replacement: required facts are missing or specifications do not match.",
    draft: "Draft prepared; the cart is unchanged. Check items, quantities and total, then use the confirmation button or reply 'yes, add'.",
    quantity: "Specify the exact article and quantity for each item. The cart is unchanged.", applied: "Items were added to the cart after your confirmation.",
    inactive: "The proposal is no longer active. Check the data and create a new one.", rejected: "Proposal rejected. The cart is unchanged.",
    noprop: "There is no displayed proposal to confirm. Select items and quantities first.",
    demo: "Demo data: prices, stock and cart do not represent a real EKT order.",
    manager: "For complex selection, contact a manager through the website Contacts section. No message is sent automatically.",
    clarify: "Which product? Please provide its article or select one product card.",
    files: "File upload is disabled in the GitHub Pages demo. Run the project locally to try specification parsing.",
  },
};

const CONFIRM = new Set(["да", "да добавь", "да добавляй", "да добавьте", "добавь", "добавьте", "добавляй", "да добавь в корзину", "добавь в корзину", "добавьте в корзину", "да в корзину", "подтверждаю", "да подтверждаю", "ок добавь", "ok добавь", "yes", "yes add", "иә", "иә қос", "қос", "себетке қос", "иә себетке қос", "растаймын"]);
const REJECT = new Set(["нет", "не надо", "нет не надо", "нет спасибо", "не нужно", "не добавляй", "отмена", "отмени", "no", "жоқ", "керек емес"]);
const normalizeReply = (text: string) => fold(text).replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();

function language(text: string, requested: string, previous: Lang): Lang {
  const q = text.toLowerCase();
  if (/english|английск|ағылшын/.test(q)) return "en";
  if (/русск|орыс|russian/.test(q)) return "ru";
  if (/қазақ|казах|kazakh/.test(q) || /[әғқңөұүһі]/.test(q)) return "kk";
  if (/[а-яё]/.test(q)) return "ru";
  if (/\b(stock|please|delivery|payment|find|add|yes|hello|price)\b/.test(q)) return "en";
  if (requested === "ru" || requested === "kk" || requested === "en") return requested;
  return previous;
}

function followupKind(text: string): "alternatives" | "product" | null {
  const tokens = fold(text).match(/[\p{L}\d]+/gu) || [];
  if (!tokens.length) return null;
  const alternatives = new Set(["аналог", "аналоги", "аналогов", "альтернатива", "альтернативы", "замена", "заменить", "alternative", "alternatives", "replacement", "equivalent", "балама", "баламасы", "аналогы"]);
  const filler = new Set(["а", "есть", "ли", "еще", "ему", "него", "нему", "этого", "этот", "товара", "товар", "его", "можно", "чем", "какие", "какой", "найди", "найдите", "подбери", "подберите", "покажи", "покажите", "пожалуйста", "для", "на", "у", "к", "тогда", "другой", "другие", "подходящий", "any", "an", "a", "is", "are", "there", "do", "you", "have", "please", "find", "show", "me", "for", "it", "this", "product", "other", "more", "бар", "ма", "ме", "осы", "тауарға", "оның"]);
  if (tokens.some(t => alternatives.has(t)) && tokens.every(t => alternatives.has(t) || filler.has(t))) return "alternatives";
  const phrase = tokens.join(" ");
  if (["характеристики", "его характеристики", "какие характеристики", "есть в наличии", "а наличие", "какая цена", "цена", "остаток", "сертификат", "есть сертификат", "specifications", "in stock", "price", "сипаттамалары", "бағасы"].includes(phrase)) return "product";
  return null;
}

const TOPICS: [string, RegExp][] = [
  ["payment", /оплат|төле|payment|pay\b|безнал|сч[её]т/i], ["delivery", /достав|жеткіз|delivery|shipping/i],
  ["min_order", /минимал|кратн|minimum|minimal|ең аз|партия/i], ["pickup", /самовывоз|pickup|алып кет/i],
  ["returns", /возврат|қайтар|return|гарант/i], ["installment", /рассроч|бөліп|installment/i],
];
// Recorded backend answers per purchase-terms topic and language (see scripts/export_demo_data.py).
const TOPIC_PROMPTS: Record<string, Partial<Record<Lang, string>>> = {
  delivery: { ru: "условия доставки", en: "delivery terms", kk: "жеткізу шарттары" },
  payment: { ru: "как оплатить заказ?", en: "payment options", kk: "төлем қалай жасалады?" },
  min_order: { ru: "минимальная партия" }, pickup: { ru: "самовывоз" }, returns: { ru: "возврат товара" }, installment: { ru: "рассрочка" },
};

function isPurchaseRequest(text: string): boolean {
  if (/(^|\s)(не|not|don't|without)(\s|$)|қоспа/i.test(text)) return false;
  return /(^|[^\p{L}])(добав\p{L}*|купить|закаж\p{L}*|хочу купить|add|buy|order|қос|сатып)([^\p{L}]|$)/iu.test(text);
}

function productLines(p: Product, w: Record<string, string>): string[] {
  const out = [`${p.article_original} — ${p.name}`, `${w.price}: ${p.price_amount ?? w.unknown} ${p.price_currency ?? ""}; ${w.stock}: ${p.sellable_quantity ?? w.unknown}`];
  if (p.min_order !== null) out.push(`min: ${p.min_order} ${p.unit ?? ""}`);
  for (const a of p.attributes.slice(0, 12)) out.push(`${a.key}: ${a.value ?? w.unknown}`);
  if (!p.certificates.length) out.push(w.nocert);
  for (const c of p.certificates) out.push(`${w.cert}: ${c.title} ${c.url}`);
  return out;
}

function answer(data: DemoData, state: DemoState, conversationId: string, text: string, requested: string, pageProductId: number | null, hasFiles: boolean): AssistantOutput {
  const convo = state.conversations[conversationId];
  const lang = language(text, requested, convo.language);
  convo.language = lang;
  const w = TEXT[lang];
  const base = { unknowns: [] as string[], proposal: null as Proposal | null, sources: [] as string[], alternative_reasons: {} as Record<string, string>, warnings: [] as string[], language: lang };
  if (hasFiles) return { ...base, message: w.files, products: [], mode: "unavailable" };

  const reply = normalizeReply(text);
  if (CONFIRM.has(reply) || REJECT.has(reply)) {
    const draft = convo.proposal ? state.proposals[convo.proposal] : null;
    if (!draft) return { ...base, message: w.noprop, products: [], mode: "action", reference_product_id: convo.reference };
    let proposal: Proposal;
    let message: string;
    if (CONFIRM.has(reply)) { proposal = confirm(state, draft.id) || draft; message = proposal.status === "applied" ? w.applied : w.inactive; }
    else { if (draft.status === "proposed") draft.status = "rejected"; proposal = draft; message = draft.status === "rejected" ? w.rejected : w.inactive; }
    return { ...base, message, products: [], mode: "action", proposal, reference_product_id: convo.reference };
  }

  const followup = followupKind(text);
  if (followup && convo.reference === null && !pageProductId) return { ...base, message: w.clarify, products: [], mode: "catalog_only", warnings: ["product_reference_required"] };

  const recorded = data.recorded[fold(text.trim())];
  if (recorded) {
    convo.reference = recorded.reference_product_id ?? convo.reference;
    return { ...recorded, products: recorded.products.map(id => byId.get(id)).filter((p): p is Product => Boolean(p)) };
  }

  const ids = identifierCandidates(text);
  const topics = TOPICS.filter(([, re]) => re.test(text)).map(([key]) => key);
  if (topics.length && !ids.length) {
    const prompt = TOPIC_PROMPTS[topics[0]][lang] || TOPIC_PROMPTS[topics[0]].ru!;
    const output = data.recorded[prompt];
    if (output) return { ...output, products: [], reference_product_id: convo.reference };
  }

  const candidates = new Map<number, Product>();
  if (followup) { const p = byId.get(convo.reference ?? pageProductId!); if (p) candidates.set(p.id, p); }
  else if (pageProductId && !ids.length) { const p = byId.get(pageProductId); if (p) candidates.set(p.id, p); }
  if (!followup) for (const p of search(data.products, text.slice(0, 200), 8)) candidates.set(p.id, p);

  const out: string[] = [];
  if (/менеджер|manager|оператор/i.test(text)) out.push(w.manager);
  const reference = candidates.size === 1 ? [...candidates.keys()][0] : null;
  const reasons: Record<string, string> = {};
  const warnings: string[] = [];
  for (const p of [...candidates.values()].slice(0, 8)) {
    if (p.stock_status === "out_of_stock" || followup === "alternatives" || /аналог|балама|alternative/i.test(text)) {
      const alt = data.alternatives[String(p.id)];
      if (!alt || !alt.ids.length) out.push(w.noalt);
      for (const id of alt?.ids || []) { const a = byId.get(id); if (a) { candidates.set(a.id, a); reasons[a.id] = alt.reasons[String(id)] || ""; } }
      warnings.push(...(alt?.warnings || []));
    }
  }
  const products = [...candidates.values()].slice(0, 12);
  let proposal: Proposal | null = null;
  if (isPurchaseRequest(text)) {
    const match = /(?<![\p{L}\d])(\d+)\s*(?:шт|pcs|дана)(?![\p{L}\d])/iu.exec(text);
    if (reference !== null && match) {
      const result = propose(state, [{ product_id: reference, quantity: Number(match[1]) }]);
      if (typeof result === "string") { out.push(result); out.push(w.quantity); }
      else {
        proposal = result; convo.proposal = result.id;
        out.push(w.draft, ...result.items.map(i => `${i.article_original}: ${i.quantity} × ${i.unit_price_amount} = ${i.line_total_amount} ${result.currency}`), `Σ ${result.total_amount} ${result.currency}`);
      }
    } else out.push(w.quantity);
  }
  for (const p of products) {
    out.push(...productLines(p, w));
    if (reasons[p.id]) out.push(`${w.alt}: ${reasons[p.id]}`);
  }
  if (products.length) out.unshift(w.demo);
  if (!products.length && !out.length) out.push(w.none);
  const unknowns: string[] = [];
  if (products.length) { out.push(w.partial); unknowns.push("catalog_coverage_is_partial_or_unknown"); }
  if (reference !== null) convo.reference = reference;
  else if (!followup && !topics.length) convo.reference = null;
  return { ...base, message: out.join("\n"), products, proposal, unknowns, alternative_reasons: reasons, warnings: [...new Set(warnings)], reference_product_id: reference, mode: "catalog_only" };
}

// ---------- Router ----------

export async function demoFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const data = await loadData();
  const url = new URL(input, "https://demo.local");
  const path = url.pathname.replace(/^\/api\/v1/, "");
  const method = (init.method || "GET").toUpperCase();
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  const state = readState();
  const save = <T,>(value: T) => { writeState(state); return value; };
  let m: RegExpMatchArray | null;

  if (path === "/session" && method === "POST") return ok({ csrf_token: "demo", expires_at: now() + 86400 });
  if (path === "/session/logout") { writeState(emptyState()); return ok({ ended: true }); }
  if (path === "/capabilities") return ok({ ...data.capabilities, upload: "requires_integration", llm: "disabled" });
  if (path === "/catalog/categories") return ok(data.categories);
  if (path === "/catalog/products") return ok(browse(data, url.searchParams));
  if (path === "/products") return ok({ items: search(data.products, url.searchParams.get("query") || "", Number(url.searchParams.get("limit") || 12)), coverage: "partial", warnings: [], reasons: {} });
  if ((m = path.match(/^\/products\/(\d+)$/))) { const p = byId.get(Number(m[1])); return p ? ok(p) : fail("not_found", "Товар не найден.", 404); }
  if ((m = path.match(/^\/products\/(\d+)\/alternatives$/))) { const alt = data.alternatives[m[1]] || { ids: [], reasons: {}, warnings: [] }; return ok({ items: alt.ids.map(id => byId.get(id)).filter(Boolean), coverage: "partial", warnings: alt.warnings, reasons: alt.reasons }); }

  if (path === "/conversations" && method === "POST") {
    const id = uid();
    state.conversations[id] = { messages: [], turns: [], reference: null, proposal: null, language: "ru" };
    return ok(save({ id, created_at: now() }));
  }
  if ((m = path.match(/^\/conversations\/(\w+)\/(messages|turns)$/))) {
    const convo = state.conversations[m[1]];
    if (!convo) return fail("not_found", "Диалог не найден.", 404);
    if (m[2] === "messages") return ok(convo.messages);
    if (method === "GET") return ok(convo.turns.map(t => t.ready_at <= Date.now() || t.status !== "running" ? { ...t, status: t.status === "running" ? "completed" : t.status } : { ...t, output: null }));
    const text = String(body.text || "").trim();
    if (!text) return fail("validation_error", "Пустое сообщение.", 422);
    const created = now();
    const output = answer(data, state, m[1], text, String(body.language || "auto"), body.page_product_id ?? null, Array.isArray(body.asset_ids) && body.asset_ids.length > 0);
    convo.messages.push({ id: uid(), role: "user", text, created_at: created }, { id: uid(), role: "assistant", text: output.message, created_at: created + 1 });
    const turn: StoredTurn = { id: uid(), conversation_id: m[1], status: "running", output, error_code: null, created_at: created, ready_at: Date.now() + 900 };
    convo.turns.push(turn);
    save(null);
    return ok({ turn: { ...turn, output: null }, created: true }, 202);
  }
  if ((m = path.match(/^\/turns\/(\w+)(\/cancel)?$/))) {
    for (const convo of Object.values(state.conversations)) {
      const turn = convo.turns.find(t => t.id === m![1]);
      if (!turn) continue;
      if (m[2] && turn.status === "running" && turn.ready_at > Date.now()) { turn.status = "cancelled"; turn.output = null; save(null); }
      const status = turn.status === "running" && turn.ready_at <= Date.now() ? "completed" : turn.status;
      return ok({ ...turn, status, output: status === "completed" ? turn.output : null });
    }
    return fail("not_found", "Ход не найден.", 404);
  }

  if (path === "/cart") return ok(state.cart);
  if (path === "/cart/proposals" && method === "POST") {
    const result = propose(state, body.items || []);
    return typeof result === "string" ? fail("validation_error", result, 422) : ok(save(result), 201);
  }
  if ((m = path.match(/^\/proposals\/(\w+)(\/confirm|\/reject)?$/))) {
    const proposal = state.proposals[m[1]];
    if (!proposal) return fail("not_found", "Предложение не найдено.", 404);
    if (m[2] === "/confirm") return ok(save(confirm(state, proposal.id)));
    if (m[2] === "/reject") { if (proposal.status === "proposed") proposal.status = "rejected"; return ok(save(proposal)); }
    return ok(proposal);
  }
  if (path.startsWith("/assets")) return fail("requires_integration", "Загрузка файлов недоступна в демо-версии на GitHub Pages.", 501);
  return fail("not_found", "Маршрут недоступен в демо-режиме.", 404);
}
