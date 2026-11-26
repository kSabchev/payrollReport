// Данните на програмата: един JSON файл (data.json), зареден в паметта.
// `data` е общ обект — модулите го променят и викат saveData().
const fs = require("fs");
const { MOCK, DATA_FILE } = require("./config");

const DEFAULT_DATA = {
  dataVersion: 2,
  settings: {
    withVat: true,           // сумите с ДДС
    operationTypes: [2],     // 2 = Продажба
    defaultRevenueColumn: "goods", // къде отиват продажбите от групи без съпоставка
  },
  // Магазини: всеки е обект в Microinvest (ObjectID) със свои разходи и оборотни пари.
  // objectId null = всички обекти (позволено само при един магазин).
  stores: [],          // [{ id, name, objectId, floatDefault }]
  byStore: {},         // id на магазин -> { expenses, revenueManual, float, floatBalance }
  revenueColumns: [
    { id: "service", name: "Сервиз" },
    { id: "prima", name: "Прима карти" },
    { id: "phones", name: "Телефони" },
    { id: "goods", name: "Стока" },
  ],
  expenseColumns: [
    { id: "misc", name: "Разни", kind: "list" },
    { id: "service", name: "Сервиз" },
    { id: "goods", name: "Стока" },
    { id: "salaries", name: "Заплати" },
    { id: "bills", name: "Сметки" },
    { id: "fuel", name: "Гориво" },
    { id: "phones", name: "Телефони" },
    { id: "eshop", name: "Онлайн магазин" },
  ],
  groupMap: {},        // id на група в Microinvest -> id на колона в Приходи (подгрупите наследяват)
  cache: {},           // "YYYY-MM-DD" -> { byObject: { обектId: { групаId: сума } }, fetchedAt } — продажбите на всички обекти
  users: [],           // акаунти (всички са администратори): [{ username, salt, hash, createdAt, lastLogin }]
  sessions: {},        // sha256(ключ от бисквитката) -> { username, created, expires }
};

// Данните на един магазин:
//   expenses:      "YYYY-MM-DD" -> { колона: число | [{name, value}] }
//   revenueManual: "YYYY-MM-DD" -> { колона: число }  (ръчни стойности и корекции)
//   float:         нулирания на оборотните пари, по дата: [{ date, amount, at }]
//   floatBalance:  "YYYY-MM-DD" -> оборотни − разходи в края на деня
const emptyStore = () => ({ expenses: {}, revenueManual: {}, float: [], floatBalance: {} });

let migratedFrom = null; // версия на данните преди преобразуване (за копие при стартиране)

function loadData() {
  let d;
  try { d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch {
    d = structuredClone(DEFAULT_DATA);
    if (MOCK) d.groupMap = { 1: "phones", 3: "prima", 4: "service" };
  }
  // apiBase/apiKey са от старата връзка през HTTP; objectId/floatDefault вече са на магазина
  const { apiBase, apiKey, objectId, floatDefault, ...settings } = d.settings || {};
  const out = { ...structuredClone(DEFAULT_DATA), ...d, settings: { ...DEFAULT_DATA.settings, ...settings } };
  if ((d.dataVersion || 1) < 2) {
    // Версия 1: един магазин, разходите и оборотните пари са на първо ниво
    migratedFrom = d.dataVersion || 1;
    out.stores = [{ id: "s1", name: "Магазин", objectId: objectId ?? null, floatDefault: floatDefault ?? 8500 }];
    out.byStore = { s1: { expenses: d.expenses || {}, revenueManual: d.revenueManual || {}, float: d.float || [], floatBalance: d.floatBalance || {} } };
    out.cache = {}; // старият кеш няма разбивка по обекти
    for (const k of ["expenses", "revenueManual", "float", "floatBalance"]) delete out[k];
    out.dataVersion = 2;
  }
  if (!out.stores.length) out.stores.push({ id: "s1", name: "Магазин", objectId: null, floatDefault: 8500 });
  for (const st of out.stores) out.byStore[st.id] = { ...emptyStore(), ...out.byStore[st.id] };
  return out;
}

const data = loadData();

function saveData() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}

module.exports = { data, saveData, emptyStore, migratedFrom: () => migratedFrom };
