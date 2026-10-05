// Task 3c.27: a SYNTHETIC product split on top of the 3c.20 synthetic fixture,
// shaped like the private baldosa split. demo-existente keeps its first variant;
// its other variants and its unconfirmed entry move to a new product
// demo-dividido. A delta step (030) records the sheet demo-existente had before,
// so its private SQL can be applied and rolled back on its own.
export const splitFixture = (base) => {
  const data = structuredClone(base);
  const existing = data.items.find((item) => item.sku === 'demo-existente');
  const previous = structuredClone(existing.technical_sheet);
  const [kept, ...moved] = previous.variants;
  existing.technical_sheet = structuredClone({
    ...previous, description: 'Producto Demo A, solo la variante A1.', variants: [kept], unconfirmed: {}, source_files: ['ficha-demo-a.pdf'],
  });
  data.items.push({
    sku: 'demo-dividido',
    action: 'create',
    name: 'Producto Demo Dividido',
    item_type: 'product',
    category_code: 'demo-categoria',
    short_description: 'Producto Demo Dividido, ficha inventada para pruebas.',
    service_keywords: ['demo'],
    applicable_cities: ['Ciudad Demo'],
    restrictions: { requires_measurements: true },
    synonyms: ['demo dividido'],
    technical_sheet: structuredClone({
      ...previous, description: 'Producto Demo Dividido, el resto de las variantes.', variants: moved,
    }),
  });
  data.deltas = [{
    id: '030', name: 'demo_split', task: '3c.27', skus: ['demo-existente', 'demo-dividido'],
    previous_technical_sheets: { 'demo-existente': previous },
  }];
  return data;
};

// Task 3c.28: a SYNTHETIC second delta (031) on top of the split, shaped like the
// private general_specs audit: a general spec that only one variant's sheet states
// moves into that variant's `other`. It touches the sku the 030 delta created and
// the one it updated, recording the sheets 030 left as their previous sheets.
export const chainFixture = (base) => {
  const data = splitFixture(base);
  const previous = {};
  for (const sku of ['demo-existente', 'demo-dividido']) {
    const sheet = data.items.find((item) => item.sku === sku).technical_sheet;
    previous[sku] = structuredClone(sheet);
    const { material, ...rest } = sheet.general_specs;
    sheet.general_specs = rest;
    sheet.variants[0].other = { ...sheet.variants[0].other, material };
  }
  data.deltas.push({
    id: '031', name: 'demo_audit', task: '3c.28', skus: ['demo-existente', 'demo-dividido'], previous_technical_sheets: previous,
  });
  return data;
};
