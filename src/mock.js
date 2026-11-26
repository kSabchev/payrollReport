// Демо данни (MOCK=1): същият интерфейс като базата на Microinvest, без база.
const { parse, daysBetween, round2 } = require("./util");
const { data } = require("./data");

const MOCK_GROUPS = [
  { id: 1, code: "001", name: "Телефони" }, { id: 2, code: "002", name: "Аксесоари" },
  { id: 5, code: "002001", name: "Кабели и зарядни" }, { id: 3, code: "003", name: "Прима карти" },
  { id: 4, code: "004", name: "Сервизни услуги" },
];
const MOCK_ITEMS = [
  [1, "Samsung Galaxy A55", 1, 649], [2, "iPhone 15 128GB", 1, 1599], [3, "Redmi Note 13", 1, 389],
  [4, "Калъф силикон", 2, 15], [5, "Протектор стъкло", 2, 20], [6, "USB-C кабел 1м", 5, 12.9],
  [7, "Зарядно 20W", 5, 29], [8, "Прима карта 10", 3, 10], [9, "Прима карта 20", 3, 20],
  [10, "Смяна на дисплей", 4, 180], [11, "Смяна на батерия", 4, 70], [12, "Диагностика", 4, 15],
].map(([id, name, groupId, price]) => ({ id, code: String(100 + id), name, groupId, price }));

// Два демо обекта; вторият продава по-малко
const MOCK_OBJECTS = [{ id: 1, code: "1", name: "Магазин Център" }, { id: 2, code: "2", name: "Магазин Мол" }];

// Псевдослучайни продажби, еднакви за дадена дата и обект
function mockLines(date, objectId = 1) {
  let seed = (Number(date.replace(/-/g, "")) + objectId * 7919) % 233280, doc = objectId * 100000 + seed % 1000 * 100;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const lines = [];
  const base = objectId === 1 ? 8 : 4;
  const n = parse(date).getDay() === 0 ? 3 : base + Math.floor(rnd() * base);
  for (let i = 0; i < n; i++) {
    const it = MOCK_ITEMS[Math.floor(rnd() * MOCK_ITEMS.length)];
    if (it.groupId === 1 && rnd() > 0.3) continue;
    const qtty = 1 + Math.floor(rnd() * (it.price < 30 ? 3 : 1));
    const price = data.settings.withVat ? it.price : round2(it.price / 1.2);
    lines.push({ goodId: it.id, name: it.name, code: it.code, groupId: it.groupId, doc: doc++, qtty, amount: qtty * price });
  }
  return lines;
}

const mockSource = {
  groups: async () => MOCK_GROUPS,
  objects: async () => MOCK_OBJECTS,
  salesByGroup: async (from, to) => daysBetween(from, to).flatMap((day) => MOCK_OBJECTS.flatMap((o) =>
    mockLines(day, o.id).map((l) => ({ day, objectId: o.id, groupId: l.groupId, amount: l.amount })))),
  saleLines: async (date, objectIds) => MOCK_OBJECTS.filter((o) => !objectIds || objectIds.includes(o.id)).flatMap((o) => mockLines(date, o.id)),
};

module.exports = { mockSource };
