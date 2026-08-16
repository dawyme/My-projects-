require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/lib/prisma');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const daysAgo = (n) => new Date(Date.now() - n * 864e5);

const CATEGORIES = [
  ['Air Conditioners', 'Split, window, ducted and portable air conditioning units.'],
  ['Refrigeration Parts', 'Commercial and domestic refrigeration components.'],
  ['Refrigerants', 'R134a, R410A, R32, R404A and specialty refrigerant gases.'],
  ['Automotive AC Parts', 'Vehicle air conditioning components and service items.'],
  ['Compressors', 'Rotary, scroll, reciprocating and automotive compressors.'],
  ['Capacitors', 'Run, start and dual-run capacitors for HVAC equipment.'],
  ['Fan Motors', 'Condenser, evaporator and blower motors.'],
  ['Filters', 'Air filters, drier filters and suction line filters.'],
  ['Copper Tubing', 'Insulated and bare copper pipe, coils and fittings.'],
  ['Thermostats', 'Digital, smart and mechanical temperature controls.'],
];

const PRODUCTS = {
  'Air Conditioners': [
    ['12,000 BTU Inverter Split AC', 'CoolAir', 'CA-INV12', 549, 380, 24],
    ['18,000 BTU Inverter Split AC', 'CoolAir', 'CA-INV18', 749, 520, 15],
    ['24,000 BTU Ducted AC System', 'Frostline', 'FL-DCT24', 1299, 940, 6],
    ['9,000 BTU Window Air Conditioner', 'Breeze', 'BZ-WIN09', 329, 225, 30],
    ['Portable 10,000 BTU AC Unit', 'Breeze', 'BZ-PRT10', 399, 268, 12],
  ],
  'Refrigeration Parts': [
    ['Evaporator Coil 1/2 HP', 'ColdCore', 'CC-EVC05', 189, 120, 18],
    ['Condensing Unit 3/4 HP', 'ColdCore', 'CC-CDU75', 615, 430, 7],
    ['Expansion Valve TXV R404A', 'Danfrost', 'DF-TXV404', 78.5, 48, 40],
    ['Solenoid Valve 3/8"', 'Danfrost', 'DF-SOL38', 64, 39, 26],
    ['Defrost Timer 220V', 'ColdCore', 'CC-DFT220', 42, 24, 35],
  ],
  Refrigerants: [
    ['R134a Refrigerant 13.6kg', 'PureGas', 'PG-R134A-136', 210, 155, 22],
    ['R410A Refrigerant 11.3kg', 'PureGas', 'PG-R410A-113', 265, 198, 16],
    ['R32 Refrigerant 9.5kg', 'PureGas', 'PG-R32-95', 189, 138, 20],
    ['R404A Refrigerant 10.9kg', 'PureGas', 'PG-R404A-109', 340, 262, 9],
    ['R600a Isobutane 6.5kg', 'PureGas', 'PG-R600A-65', 128, 92, 14],
  ],
  'Automotive AC Parts': [
    ['Automotive AC Condenser Universal', 'AutoChill', 'AC-CND-UNI', 145, 96, 19],
    ['Cabin Blower Motor 12V', 'AutoChill', 'AC-BLW12', 88, 55, 27],
    ['AC Receiver Drier Inline', 'AutoChill', 'AC-DRY-IN', 34.5, 19, 48],
    ['Car AC Manifold Gauge Set', 'ToolPro', 'TP-MGS-01', 119, 74, 11],
    ['Automotive AC Hose Crimp Kit', 'ToolPro', 'TP-HCK-02', 275, 190, 4],
  ],
  Compressors: [
    ['Rotary Compressor 1.5HP R410A', 'CompMax', 'CM-ROT15', 385, 268, 8],
    ['Scroll Compressor 3HP', 'CompMax', 'CM-SCR30', 890, 640, 3],
    ['Reciprocating Compressor 1/3 HP', 'CompMax', 'CM-REC033', 215, 148, 12],
    ['Automotive AC Compressor 12V', 'AutoChill', 'AC-CMP12', 320, 225, 6],
    ['Hermetic Compressor 1/4 HP R134a', 'CompMax', 'CM-HRM025', 178, 118, 21],
  ],
  Capacitors: [
    ['Dual Run Capacitor 45+5 MFD', 'VoltCore', 'VC-DR455', 24.5, 12, 60],
    ['Run Capacitor 35 MFD 440V', 'VoltCore', 'VC-RUN35', 18.9, 9, 75],
    ['Start Capacitor 88-108 MFD', 'VoltCore', 'VC-STR88', 21, 10.5, 44],
    ['Dual Run Capacitor 60+7.5 MFD', 'VoltCore', 'VC-DR607', 29.9, 15, 32],
    ['Capacitor 5 MFD 370V', 'VoltCore', 'VC-CAP05', 11.5, 5.2, 90],
  ],
  'Fan Motors': [
    ['Condenser Fan Motor 1/4 HP', 'AeroSpin', 'AS-CFM025', 132, 88, 17],
    ['Evaporator Blower Motor 1/6 HP', 'AeroSpin', 'AS-EBM016', 98, 62, 23],
    ['ECM Variable Speed Blower Motor', 'AeroSpin', 'AS-ECM-VS', 289, 205, 5],
    ['Axial Fan Motor 550mm', 'AeroSpin', 'AS-AXF550', 175, 118, 9],
    ['Shaded Pole Motor 16W', 'AeroSpin', 'AS-SPM16', 39.5, 21, 52],
  ],
  Filters: [
    ['Pleated Air Filter 20x25x1 MERV 11', 'PureFlow', 'PF-AF2025', 14.5, 6.8, 120],
    ['Liquid Line Filter Drier 3/8"', 'PureFlow', 'PF-LLD38', 27, 15, 58],
    ['Suction Line Filter 7/8"', 'PureFlow', 'PF-SLF78', 62, 38, 19],
    ['HEPA Filter Cartridge H13', 'PureFlow', 'PF-HEPA13', 89, 54, 14],
    ['Washable Aluminium Mesh Filter', 'PureFlow', 'PF-WAM-01', 22, 11, 66],
  ],
  'Copper Tubing': [
    ['Copper Pipe 1/4" Insulated 15m', 'CuLine', 'CU-INS14-15', 96, 62, 26],
    ['Copper Pipe 3/8" Insulated 15m', 'CuLine', 'CU-INS38-15', 138, 92, 18],
    ['Soft Copper Coil 1/2" 15m', 'CuLine', 'CU-SFT12-15', 172, 118, 10],
    ['Copper Flare Fitting Set', 'CuLine', 'CU-FLR-SET', 34, 18, 41],
    ['Copper Pipe 5/8" Hard Drawn 6m', 'CuLine', 'CU-HD58-6', 118, 79, 13],
  ],
  Thermostats: [
    ['Smart WiFi Thermostat', 'ThermoLogic', 'TL-WIFI-01', 189, 124, 16],
    ['Digital Programmable Thermostat', 'ThermoLogic', 'TL-DIG-PRG', 78, 46, 29],
    ['Refrigeration Digital Controller', 'ThermoLogic', 'TL-RDC-220', 92, 58, 21],
    ['Mechanical Room Thermostat', 'ThermoLogic', 'TL-MEC-01', 26, 13, 47],
    ['Defrost Thermostat Bimetal', 'ThermoLogic', 'TL-DFT-BM', 18.5, 8.4, 55],
  ],
};

const SERVICES = [
  ['AC Installation', 'Full supply and installation of split or ducted air conditioning.', 350, 240],
  ['AC Repair & Diagnostics', 'Fault-finding and repair for residential and commercial AC.', 120, 90],
  ['Preventive Maintenance', 'Scheduled cleaning, gas check and performance tuning.', 95, 75],
  ['Refrigeration Servicing', 'Cold room, chiller and display fridge servicing.', 180, 120],
  ['Automotive AC Re-gas', 'Vehicle AC evacuation, leak test and re-gas.', 85, 60],
  ['Emergency Callout', '24/7 emergency HVAC and refrigeration response.', 250, 120],
];

const CUSTOMERS = [
  ['James Whitfield', 'james.whitfield@example.com', '+1 555 0142', 'Whitfield Grocers', 'Springfield'],
  ['Amara Okafor', 'amara.okafor@example.com', '+1 555 0198', null, 'Riverton'],
  ['Luis Hernandez', 'luis.hernandez@example.com', '+1 555 0177', 'Hernandez Auto Care', 'Springfield'],
  ['Priya Raghavan', 'priya.raghavan@example.com', '+1 555 0121', 'Spice Route Restaurant', 'Lakeside'],
  ['Tom Bergstrom', 'tom.bergstrom@example.com', '+1 555 0165', null, 'Riverton'],
  ['Nadia Haddad', 'nadia.haddad@example.com', '+1 555 0133', 'Haddad Pharmacy', 'Springfield'],
  ['Kevin Osei', 'kevin.osei@example.com', '+1 555 0189', 'Frostbite Cold Storage', 'Lakeside'],
  ['Sofia Rossi', 'sofia.rossi@example.com', '+1 555 0154', null, 'Springfield'],
  ['Daniel Mwangi', 'daniel.mwangi@example.com', '+1 555 0107', 'Mwangi Logistics', 'Riverton'],
  ['Helen Park', 'helen.park@example.com', '+1 555 0116', null, 'Lakeside'],
];

const MESSAGES = [
  ['Quote for cold room install', 'We need a quote for a 30m³ cold room for our grocery store. Can someone visit this week?'],
  ['AC not cooling', 'My split unit runs but blows warm air. Do you do same-day callouts?'],
  ['Bulk refrigerant pricing', 'Do you offer trade pricing on R410A cylinders? We buy roughly 10 per month.'],
  ['Car AC smells musty', 'The AC in my van has a strong smell. Is that a filter or evaporator issue?'],
  ['Maintenance contract', 'Interested in an annual maintenance contract for 6 rooftop units.'],
  ['Warranty question', 'Purchased a compressor two months ago — what is the warranty procedure?'],
  ['Thermostat compatibility', 'Will the smart WiFi thermostat work with a 2-stage heat pump?'],
];

async function reset() {
  // Order matters because of foreign keys.
  await prisma.messageReply.deleteMany();
  await prisma.contactMessage.deleteMany();
  await prisma.bookingNote.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.inventoryAdjustment.deleteMany();
  await prisma.restock.deleteMany();
  await prisma.product.deleteMany();
  await prisma.category.deleteMany();
  await prisma.service.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.mediaAsset.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.promotionItem.deleteMany();
  await prisma.faqItem.deleteMany();
  await prisma.galleryItem.deleteMany();
  await prisma.testimonial.deleteMany();
  await prisma.serviceItem.deleteMany();
  await prisma.contentPage.deleteMany();
}

async function main() {
  console.log('Seeding database…');
  await reset();

  // ---- users
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
  const staffPassword = process.env.SEED_STAFF_PASSWORD || 'Staff@12345';
  const admin = await prisma.user.create({
    data: {
      name: 'Grace Adeyemi', email: (process.env.SEED_ADMIN_EMAIL || 'admin@ndsairconditioning.com').toLowerCase(),
      passwordHash: await bcrypt.hash(adminPassword, 12), role: 'ADMIN', phone: '+1 555 0100',
    },
  });
  const staff = await prisma.user.create({
    data: {
      name: 'Marcus Reed', email: (process.env.SEED_STAFF_EMAIL || 'staff@ndsairconditioning.com').toLowerCase(),
      passwordHash: await bcrypt.hash(staffPassword, 12), role: 'STAFF', phone: '+1 555 0101',
    },
  });
  const tech2 = await prisma.user.create({
    data: { name: 'Ibrahim Sesay', email: 'ibrahim.sesay@ndsairconditioning.com', passwordHash: await bcrypt.hash(staffPassword, 12), role: 'STAFF', phone: '+1 555 0102' },
  });
  const technicians = [staff, tech2, admin];
  console.log(`  ✔ 3 users (admin: ${admin.email})`);

  // ---- categories & products
  const categories = {};
  for (let i = 0; i < CATEGORIES.length; i++) {
    const [name, description] = CATEGORIES[i];
    categories[name] = await prisma.category.create({ data: { name, slug: slug(name), description, sortOrder: i } });
  }
  const products = [];
  for (const [catName, list] of Object.entries(PRODUCTS)) {
    for (const [name, brand, sku, price, costPrice, quantity] of list) {
      products.push(await prisma.product.create({
        data: {
          sku, name, slug: slug(name), brand, model: sku,
          description: `${name} by ${brand}. Genuine ${catName.toLowerCase()} stocked and supported by N&D'S Air Conditioning & Refrigeration Services.`,
          categoryId: categories[catName].id, price, costPrice, quantity,
          lowStockLevel: rand(5, 12), unit: 'unit',
          imageUrl: '/assets/images/placeholder-product.svg',
          specs: JSON.stringify({ Brand: brand, Model: sku, Warranty: '12 months', Category: catName }),
          featured: Math.random() < 0.18,
          createdAt: daysAgo(rand(1, 300)),
        },
      }));
    }
  }
  console.log(`  ✔ ${Object.keys(categories).length} categories, ${products.length} products`);

  // ---- services
  const services = [];
  for (const [name, description, basePrice, durationMin] of SERVICES) {
    services.push(await prisma.service.create({ data: { name, slug: slug(name), description, basePrice, durationMin } }));
  }

  // ---- customers
  const customers = [];
  for (const [name, email, phone, company, city] of CUSTOMERS) {
    customers.push(await prisma.customer.create({
      data: {
        name, email, phone, company, city, state: 'IL', country: undefined,
        address: `${rand(10, 900)} ${pick(['Maple', 'Oak', 'Industrial', 'Riverside', 'Chestnut'])} ${pick(['St', 'Ave', 'Way'])}`,
        postalCode: String(rand(60000, 69999)),
        createdAt: daysAgo(rand(5, 400)),
      },
    }));
  }
  console.log(`  ✔ ${services.length} services, ${customers.length} customers`);

  // ---- bookings spread over the last 12 months
  const STATUSES = ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'CANCELLED'];
  let bookingCount = 0;
  for (let i = 0; i < 70; i++) {
    const created = daysAgo(rand(0, 360));
    const scheduled = new Date(created.getTime() + rand(1, 10) * 864e5);
    const isPast = scheduled < new Date();
    const status = isPast ? pick(STATUSES) : pick(['PENDING', 'CONFIRMED']);
    const service = pick(services);
    const customer = pick(customers);
    const booking = await prisma.booking.create({
      data: {
        reference: `BK-${created.getTime().toString(36).toUpperCase()}-${i}`,
        customerId: customer.id, serviceId: service.id,
        technicianId: status === 'PENDING' ? (Math.random() < 0.4 ? pick(technicians).id : null) : pick(technicians).id,
        scheduledAt: scheduled,
        completedAt: status === 'COMPLETED' ? scheduled : null,
        status, priority: pick(['LOW', 'NORMAL', 'NORMAL', 'HIGH', 'URGENT']),
        address: customer.address, description: `${service.name} for ${customer.company || customer.name}.`,
        price: Math.round((service.basePrice * (0.9 + Math.random() * 0.5)) * 100) / 100,
        createdAt: created,
      },
    });
    bookingCount++;
    if (Math.random() < 0.45) {
      await prisma.bookingNote.create({
        data: {
          bookingId: booking.id, userId: pick(technicians).id,
          body: pick([
            'Customer confirmed access for the scheduled window.',
            'Parts required: run capacitor and filter drier.',
            'Unit low on refrigerant — leak test performed, no leaks found.',
            'Site has restricted parking; van access via rear gate.',
            'Follow-up service recommended in 6 months.',
          ]),
          createdAt: booking.createdAt,
        },
      });
    }
  }
  // guarantee visible activity this week
  for (let i = 0; i < 6; i++) {
    const customer = pick(customers);
    const service = pick(services);
    await prisma.booking.create({
      data: {
        reference: `BK-UPC-${i}-${Date.now().toString(36).toUpperCase()}`,
        customerId: customer.id, serviceId: service.id,
        technicianId: i % 2 === 0 ? pick(technicians).id : null,
        scheduledAt: new Date(Date.now() + (i + 1) * 36e5 * 8),
        status: i % 3 === 0 ? 'PENDING' : 'CONFIRMED', priority: pick(['NORMAL', 'HIGH']),
        address: customer.address, description: `${service.name} — upcoming appointment.`,
        price: service.basePrice,
      },
    });
    bookingCount++;
  }
  console.log(`  ✔ ${bookingCount} bookings`);

  // ---- orders
  let orderCount = 0;
  for (let i = 0; i < 45; i++) {
    const created = daysAgo(rand(0, 360));
    const customer = pick(customers);
    const lineCount = rand(1, 4);
    const chosen = [];
    for (let j = 0; j < lineCount; j++) {
      const p = pick(products);
      if (!chosen.find((c) => c.id === p.id)) chosen.push(p);
    }
    const items = chosen.map((p) => {
      const quantity = rand(1, 4);
      return { productId: p.id, quantity, unitPrice: p.price, total: Math.round(p.price * quantity * 100) / 100 };
    });
    const subtotal = Math.round(items.reduce((s, l) => s + l.total, 0) * 100) / 100;
    const tax = Math.round(subtotal * 0.075 * 100) / 100;
    await prisma.order.create({
      data: {
        reference: `OR-${created.getTime().toString(36).toUpperCase()}-${i}`,
        customerId: customer.id,
        status: pick(['PAID', 'PAID', 'COMPLETED', 'COMPLETED', 'SHIPPED', 'PENDING', 'CANCELLED']),
        subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100,
        createdAt: created, items: { create: items },
      },
    });
    orderCount++;
  }
  console.log(`  ✔ ${orderCount} orders`);

  // ---- messages
  for (let i = 0; i < MESSAGES.length; i++) {
    const [subject, body] = MESSAGES[i];
    const customer = pick(customers);
    await prisma.contactMessage.create({
      data: {
        name: customer.name, email: customer.email, phone: customer.phone, subject, body,
        status: i < 3 ? 'UNREAD' : i < 6 ? 'READ' : 'ARCHIVED',
        customerId: customer.id, createdAt: daysAgo(rand(0, 30)),
      },
    });
  }
  console.log(`  ✔ ${MESSAGES.length} contact messages`);

  // ---- inventory movements
  for (let i = 0; i < 18; i++) {
    const p = pick(products);
    const quantity = rand(5, 40);
    await prisma.restock.create({
      data: { productId: p.id, quantity, unitCost: p.costPrice, supplier: pick(['Northline Supply', 'Delta Wholesale', 'Arctic Distributors']), reference: `PO-${rand(1000, 9999)}`, receivedAt: daysAgo(rand(1, 200)) },
    });
    await prisma.inventoryAdjustment.create({
      data: { productId: p.id, userId: pick(technicians).id, change: quantity, before: p.quantity, after: p.quantity + quantity, reason: 'Supplier restock', createdAt: daysAgo(rand(1, 200)) },
    });
  }
  // force a few low-stock alerts so the widget is meaningful
  const lowStockTargets = products.slice(0, 4);
  for (const p of lowStockTargets) {
    await prisma.product.update({ where: { id: p.id }, data: { quantity: rand(0, 3), lowStockLevel: 8 } });
  }
  console.log('  ✔ inventory history and low-stock samples');

  // ---- website content (Content Manager seed)
  const { PAGE_DEFAULTS, serialize } = require('../src/routes/content');
  for (const key of Object.keys(PAGE_DEFAULTS)) {
    const def = PAGE_DEFAULTS[key];
    await prisma.contentPage.upsert({
      where: { key },
      update: {},
      create: { key, title: def.title, slug: key, content: serialize(def.content), status: 'PUBLISHED', publishedAt: new Date() },
    });
  }
  console.log(`  ✔ ${Object.keys(PAGE_DEFAULTS).length} content pages (published)`);

  const siteServices = [
    ['AC Repair & Installation', 'fa-snowflake', true, 'Fast, reliable installation and repair of residential split and window air conditioners.'],
    ['Commercial Refrigeration', 'fa-warehouse', true, 'Walk-in coolers, freezers and cold-room design, installation and maintenance.'],
    ['Automotive AC', 'fa-car', true, 'Vehicle air conditioning repair, recharging and component replacement.'],
    ['Preventive Maintenance', 'fa-shield-alt', true, 'Scheduled maintenance plans that keep your systems efficient and reliable.'],
    ['Emergency Service', 'fa-exclamation-triangle', true, '24/7 emergency callout for urgent breakdowns and failures.'],
    ['Cold Rooms & Freezers', 'fa-thermometer', true, 'Commercial cold room and freezer installations for businesses.'],
    ['Residential Installation', 'fa-home', false, 'Complete home air conditioning installation with professional ducting.'],
    ['Ventilation & IAQ', 'fa-wind', false, 'Improve indoor air quality with professional ventilation solutions.'],
  ];
  for (const [i, s] of siteServices.entries()) {
    const [name, icon, featured, description] = s;
    await prisma.serviceItem.create({
      data: {
        name, slug: slug(name), icon, featured, description,
        content: `<p>${description}</p><p>Our certified technicians deliver dependable ${name.toLowerCase()} services backed by years of experience.</p>`,
        sortOrder: i, status: 'PUBLISHED', publishedAt: new Date(),
      },
    });
  }
  console.log(`  ✔ ${siteServices.length} site services`);

  const testimonials = [
    ['Maria Santos', 'Owner, Santos Grocery', 'Fast, professional service. Fixed our commercial walk-in freezer the same day. Highly recommend!', 5],
    ['David Williams', 'Homeowner, Port of Spain', 'Excellent installation of our new mini-split. The team was clean, polite, and efficient.', 5],
    ['Keisha Thomas', 'Vehicle Owner', 'My car\'s AC was fixed in under 2 hours. Great price and honest diagnosis. Will return for sure.', 5],
    ['Robert Charles', 'Facilities Manager, Cascade Plaza', 'They maintain all our rooftop units. Responsive, thorough and always on time.', 4],
  ];
  for (const [i, t] of testimonials.entries()) {
    const [name, company, review, rating] = t;
    await prisma.testimonial.create({ data: { name, company, review, rating, sortOrder: i, status: 'PUBLISHED', publishedAt: new Date() } });
  }
  console.log(`  ✔ ${testimonials.length} testimonials`);

  const galleryItems = [
    ['Residential mini-split installation', 'Residential', '/assets/images/residential-installation.svg'],
    ['Commercial rooftop units', 'Commercial', '/assets/images/commercial-installation.svg'],
    ['Walk-in freezer repair', 'Refrigeration', '/assets/images/commercial-refrigeration.svg'],
    ['Ductless system install', 'Residential', '/assets/images/ductless-installation.svg'],
  ];
  for (const [i, g] of galleryItems.entries()) {
    const [title, category, imageUrl] = g;
    await prisma.galleryItem.create({ data: { title, category, imageUrl, thumbUrl: imageUrl, sortOrder: i, status: 'PUBLISHED', publishedAt: new Date() } });
  }
  console.log(`  ✔ ${galleryItems.length} gallery items`);

  const faqs = [
    ['Do you offer emergency service?', 'Yes, we provide 24/7 emergency callout for urgent breakdowns. Call our emergency line any time.', 'General'],
    ['How often should I service my AC?', 'We recommend a professional service at least twice a year, ideally before each hot season.', 'Maintenance'],
    ['Do you service commercial refrigerators?', 'Yes, we install and maintain walk-in coolers, freezers and cold rooms for businesses.', 'Commercial'],
    ['Are your technicians certified?', 'All our technicians are certified and fully insured.', 'General'],
  ];
  for (const [i, f] of faqs.entries()) {
    const [question, answer, category] = f;
    await prisma.faqItem.create({ data: { question, answer, category, sortOrder: i, status: 'PUBLISHED', publishedAt: new Date() } });
  }
  console.log(`  ✔ ${faqs.length} FAQs`);

  const promotions = [
    ['Free AC Health Check', 'Book any installation and receive a free 10-point AC health check.', '/assets/images/ac-repair.svg', '/booking.html', 'LIMITED TIME'],
    ['Seasonal Maintenance Special', '20% off preventive maintenance plans this month.', '/assets/images/maintenance.svg', '/services/preventive-maintenance.html', 'SAVE 20%'],
  ];
  for (const [i, p] of promotions.entries()) {
    const [title, body, imageUrl, link, badge] = p;
    await prisma.promotionItem.create({ data: { title, body, imageUrl, link, badge, sortOrder: i, status: 'PUBLISHED', publishedAt: new Date(), startAt: daysAgo(5), endAt: new Date(Date.now() + 30 * 864e5) } });
  }
  console.log(`  ✔ ${promotions.length} promotions`);

  const team = [
    ['Grace Adeyemi', 'Founder & Lead Technician', 'Over 15 years of hands-on HVAC and refrigeration experience.'],
    ['Marcus Reed', 'Service Manager', 'Coordinates our technician team and ensures quality service delivery.'],
    ['Ibrahim Sesay', 'Senior Technician', 'Specialist in commercial refrigeration and cold rooms.'],
    ['Amara Cole', 'Customer Support', 'Friendly point of contact for bookings and enquiries.'],
  ];
  for (const [i, m] of team.entries()) {
    const [name, role, bio] = m;
    await prisma.teamMember.create({ data: { name, role, bio, photoUrl: '/assets/images/team-member-1.svg', sortOrder: i, status: 'PUBLISHED', publishedAt: new Date() } });
  }
  console.log(`  ✔ ${team.length} team members`);

  // ---- activity feed
  const feed = [
    ['booking', `${staff.name} completed a maintenance visit`, staff.id],
    ['product', `${admin.name} updated pricing on 5 products`, admin.id],
    ['inventory', `${tech2.name} restocked R410A refrigerant`, tech2.id],
    ['customer', `${admin.name} added a new commercial customer`, admin.id],
    ['message', 'New contact message received from the website', null],
    ['order', `${staff.name} processed a parts order`, staff.id],
    ['booking', `${tech2.name} was assigned an emergency callout`, tech2.id],
    ['auth', `${admin.name} signed in`, admin.id],
  ];
  for (let i = 0; i < feed.length; i++) {
    const [type, message, userId] = feed[i];
    await prisma.activity.create({ data: { type, message, userId, createdAt: new Date(Date.now() - i * 27e5) } });
  }

  console.log('\nSeed complete.');
  console.log('----------------------------------------------');
  console.log(`  Admin login:  ${admin.email} / ${adminPassword}`);
  console.log(`  Staff login:  ${staff.email} / ${staffPassword}`);
  console.log('----------------------------------------------\n');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
