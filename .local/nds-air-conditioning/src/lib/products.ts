// Product data for HVAC, Refrigeration, and Automotive AC business
export type Product = {
  id: string;
  name: string;
  description: string;
  price: number;
  originalPrice?: number; // For showing discounts
  image: string;
  category: string;
  subcategory: string;
  stock: number;
  rating: number;
  reviewCount: number;
  features?: string[];
  specs?: Record<string, string>;
  slug: string;
  isFeatured?: boolean;
  isNew?: boolean;
};

// Product categories matching the business requirements
export const productCategories = [
  "Refrigeration",
  "Air Conditioning",
  "Automotive Air Conditioning"
];

// Mock product data - in a real app, this would come from a database or CMS
export const products: Product[] = [
  // REFRIGERATION PRODUCTS
  {
    id: "ref-001",
    name: "Copeland Scroll Compressor ZR94KCE-TFD-522",
    description: "High-efficiency scroll compressor for commercial refrigeration applications. R-404A/R-507 refrigerant compatible.",
    price: 1249.99,
    originalPrice: 1399.99,
    image: "/products/compressor-copeland.jpg",
    category: "Refrigeration",
    subcategory: "Compressors",
    stock: 15,
    rating: 4.8,
    reviewCount: 24,
    features: [
      "High energy efficiency",
      "Low vibration and sound levels",
      "Extended operating envelope",
      "Motor protection electronics"
    ],
    specs: {
      "Capacity": "94,000 BTU/h",
      "Voltage": "208-230/3/60",
      "Refrigerant": "R-404A/R-507",
      "Connection Type": "Rotlock"
    },
    slug: "copeland-scroll-compressor-zr94kce",
    isFeatured: true,
    isNew: false
  },
  {
    id: "ref-002",
    name: "Danfoss TP5ST Thermostat",
    description: "Electronic thermostat for precise temperature control in refrigeration systems. Includes defrost control.",
    price: 189.99,
    image: "/products/thermostat-danfoss.jpg",
    category: "Refrigeration",
    subcategory": "Thermostats",
    stock: 32,
    rating: 4.6,
    reviewCount: 18,
    features: [
      "Precise temperature control",
      "Defrost timer function",
      "Alarm output",
      "Easy-to-read display"
    ],
    specs: {
      "Temperature Range": "-40°F to 50°F",
      "Voltage": "12-24V AC/DC",
      "Output": "16A resistive",
      "Mounting": "Wall or panel mount"
    },
    slug: "danfoss-tp5st-thermostat",
    isFeatured: true,
    isNew: true
  },
  {
    id: "ref-003",
    name: "Marshalltown Condenser Fan Motor 1/2 HP",
    description: "PSC condenser fan motor for refrigeration and air conditioning units. Includes mounting hardware.",
    price: 149.99,
    image: "/products/fan-motor-marshalltown.jpg",
    category: "Refrigeration",
    subcategory": "Fan Motors",
    stock: 24,
    rating: 4.7,
    reviewCount: 31,
    features: [
      "High efficiency PSC design",
      "Thermal overload protection",
      "Double sealed bearings",
      "Universal mounting"
    ],
    specs: {
      "Horsepower": "1/2 HP",
      "Voltage": "208-230V",
      "Speed": "1075 RPM",
      "Frame Size": "48Y"
    },
    slug: "marshalltown-condenser-fan-motor-1-2-hp",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ref-004",
    name: "Dual Run Capacitor 5+5 MFD 440V",
    description: "Dual run capacitor for compressor and fan motor circuits. Self-healing metallized polypropylene film.",
    price: 24.99,
    image: "/products/capacitor-dual.jpg",
    category: "Refrigeration",
    subcategory": "Capacitors",
    stock: 87,
    rating: 4.5,
    reviewCount: 42,
    features: [
      "Self-healing technology",
      "Pressure sensitive interrupter",
      "UL 810 certified",
      "Operates -40°C to +70°C"
    ],
    specs: {
      "Capacitance": "5+5 MFD ±6%",
      "Voltage": "440V AC",
      "Frequency": "50/60 Hz",
      "Case Style": "Oval"
    },
    slug: "dual-run-capacitor-5-5-mfd-440v",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ref-005",
    name: "Copper Tubing 1/2\" Type L Rolled 50ft",
    description: "ASTM B88 seamless copper water tube, Type L, suitable for refrigeration and air conditioning piping.",
    price: 89.99,
    image: "/products/copper-tubing.jpg",
    category: "Refrigeration",
    subcategory": "Copper Tubing",
    stock: 18,
    rating: 4.9,
    reviewCount: 15,
    features: [
      "Seamless copper construction",
      "ASTM B88 compliant",
      "Type L wall thickness",
      "Clean and dehydrated"
    ],
    specs: {
      "Size": "1/2\" OD",
      "Type": "L",
      "Length": "50 feet",
      "Temp Rating": "Up to 400°F"
    },
    slug: "copper-tubing-1-2-type-l-50ft",
    isFeatured: false,
    isNew: true
  },
  {
    id: "ref-006",
    name: "Parker Hannifin Filter Drier EK-163S",
    description: "Bi-flow filter drier for heat pump applications. Removes moisture, acid, and particulates from refrigerant.",
    price: 34.99,
    image: "/products/filter-drier-parker.jpg",
    category: "Refrigeration",
    subcategory": "Filter Driers",
    stock: 41,
    rating: 4.6,
    reviewCount: 22,
    features: [
      "Bi-flow design",
      "High moisture capacity",
      "Solid core filtration",
      "Corrosion resistant epoxy powder coating"
    ],
    specs: {
      "Capacity": "16",
      "Connection": "3/8\" ODF x 3/8\" ODF",
      "Refrigerant": "All common HFCs, HCFCs",
      "Flow Direction": "Bi-flow"
    },
    slug: "parker-filter-drier-ek-163s",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ref-007",
    name: "Refrigerant R-134a 30lb Cylinder",
    description: "Virgin R-134a refrigerant in disposable cylinder. Non-ozone depleting HFC refrigerant for medium and high temperature applications.",
    price: 189.99,
    image: "/products/refrigerant-r134a.jpg",
    category: "Refrigeration",
    subcategory": "Refrigerants",
    stock: 22,
    rating: 4.4,
    reviewCount: 19,
    features: [
      "Zero ozone depletion potential",
      "Non-flammable",
      "AHRI 700 certified",
      "Includes valve cap"
    ],
    specs: {
      "Type": "R-134a (HFC-134a)",
      "Weight": "30 lbs",
      "Purity": "≥99.5%",
      "Cylinder": "Disposable with 1/2\" ACME valve"
    },
    slug: "refrigerant-r134a-30lb",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ref-008",
    name: "Refrigerant R-404A 24lb Cylinder",
    description: "R-404A refrigerant blend for low and medium temperature refrigeration. Zerolike ozone depletion potential.",
    price: 219.99,
    image: "/products/refrigerant-r404a.jpg",
    category: "Refrigeration",
    subcategory": "Refrigerants",
    stock: 18,
    rating: 4.3,
    reviewCount: 15,
    features: [
      "Zeotropic blend",
      "Good capacity and efficiency",
      "Widely accepted in industry",
      "Non-flammable"
    ],
    specs: {
      "Type": "R-404A (HFC blend)",
      "Weight": "24 lbs",
      "Purity": "≥98.0%",
      "Components": "R-125/143a/134a (44/52/4%)"
    },
    slug: "refrigerant-r404a-24lb",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ref-009",
    name: "Refrigerant R-600a (Isobutane) 8oz Can",
    description: "R-600a (isobutane) refrigerant for domestic refrigeration. Natural hydrocarbon with excellent thermodynamic properties.",
    price: 12.99,
    image: "/products/refrigerant-r600a.jpg",
    category: "Refrigeration",
    subcategory": "Refrigerants",
    stock: 65,
    rating: 4.7,
    reviewCount: 28,
    features: [
      "Natural refrigerant",
      "Very low GWP (3)",
      "Excellent energy efficiency",
      "Compatible with mineral oil"
    ],
    specs: {
      "Type": "R-600a (Isobutane)",
      "Weight": "8 oz",
      "Purity": "≥99.5%",
      "Flammability": "A3 (Higher flammability)"
    },
    slug: "refrigerant-r600a-8oz",
    isFeatured: false,
    isNew: true
  },
  {
    id: "ref-010",
    name: "Refrigerant R-290 (Propane) 5lb Cylinder",
    description: "R-290 (propane) refrigerant for commercial refrigeration. Natural refrigerant with negligible environmental impact.",
    price: 45.99,
    image: "/products/refrigerant-r290.jpg",
    category: "Refrigeration",
    subcategory": "Refrigerants",
    stock: 12,
    rating: 4.8,
    reviewCount: 11,
    features: [
      "Natural refrigerant",
      "GWP of 3",
      "Excellent thermodynamic properties",
      "Cost effective"
    ],
    specs: {
      "Type": "R-290 (Propane)",
      "Weight": "5 lbs",
      "Purity": "≥99.5%",
      "Flammability": "A3 (Higher flammability)"
    },
    slug: "refrigerant-r290-5lb",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ref-011",
    name: "Ritchie Engineering Manifold Gauge Set",
    description: "4-valve manifold gauge set with 60\" hoses for R-410A, R-22, R-134A and other refrigerants. Includes ball valves.",
    price: 129.99,
    image: "/products/manifold-gauge-set.jpg",
    category: "Refrigeration",
    subcategory": "Tools and Accessories",
    stock: 18,
    rating: 4.6,
    reviewCount: 22,
    features: [
      "4-valve design",
      "60\" barrier hoses",
      "Ball valve technology",
      "Shock resistant boot"
    ],
    specs: {
      "Refrigerants": "R-410A, R-22, R-134A, R-404A, R-507",
      "Pressure Range": "0-800 PSI",
      "Hose Length": "60 inches",
      "Weight": "4.5 lbs"
    },
    slug: "ritchie-manifold-gauge-set",
    isFeatured: false,
    isNew: false
  },

  // AIR CONDITIONING PRODUCTS
  {
    id: "ac-001",
    name: "Mitsubishi Mini Split MSZ-FH12NA",
    description: "12,000 BTU wall-mounted ductless mini-split air conditioner with hyper-heating technology for extreme climates.",
    price: 1199.99,
    originalPrice: 1399.99,
    image: "/products/mitsubishi-minisplit.jpg",
    category: "Air Conditioning",
    subcategory": "Split AC Units",
    stock: 8,
    rating: 4.9,
    reviewCount: 34,
    features: [
      "Hyper-heating technology",
      "3D i-see Sensor",
      "Quiet operation (19 dB)",
      "Wi-Fi control optional",
      "ENERGY STAR certified"
    ],
    specs: {
      "Capacity": "12,000 BTU/h",
      "SEER": "33.1",
      "HSPF": "14.2",
      "Voltage": "208/230V",
      "Refrigerant": "R-410A"
    },
    slug: "mitsubishi-minisplit-msz-fh12na",
    isFeatured: true,
    isNew: false
  },
  {
    id: "ac-002",
    name: "Frigidaire FFRA0511R1 5,000 BTU Window AC",
    description: "5,000 BTU window air conditioner for rooms up to 150 sq ft. Mechanical controls with multiple fan speeds.",
    price: 179.99,
    image: "/products/frigidaire-window-ac.jpg",
    category: "Air Conditioning",
    subcategory": "Window AC Units",
    stock: 25,
    rating: 4.4,
    reviewCount: 45,
    features: [
      "Mechanical controls",
      "Multiple fan speeds",
      "Washable filter",
      "Space-saving design",
      "Easy installation"
    ],
    specs: {
      "Capacity": "5,000 BTU/h",
      "Coverage": "Up to 150 sq ft",
      "Energy Star": "No",
      "Voltage": "115V",
      "Refrigerant": "R-410A"
    },
    slug: "frigidaire-window-ac-5000btu",
    isFeatured: false,
    isNew: true
  },
  {
    id: "ac-003",
    name: "Honeywell MN10CESWW Portable AC",
    description: "10,000 BTU portable air conditioner with dehumidifier and fan functions. Includes window kit and remote control.",
    price: 499.99,
    image: "/products/honeywell-portable-ac.jpg",
    category: "Air Conditioning",
    subcategory": "Portable AC Units",
    stock: 12,
    rating: 4.3,
    reviewCount: 28,
    features: [
      "3-in-1 functionality",
      "Evaporative technology",
      "Auto-evaporation system",
      "Digital controls",
      "Remote control included"
    ],
    specs: {
      "Capacity": "10,000 BTU/h",
      "Dehumidification": "2.9 pts/hr",
      "Air Flow": "174 CFM",
      "Voltage": "115V",
      "Refrigerant": "R-410A"
    },
    slug: "honeywell-portable-ac-10000btu",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ac-004",
    name: "Copeland Scroll Compressor ZR42K3E-TF5-950",
    description: "Scroll compressor for residential and light commercial air conditioning applications. R-410A refrigerant.",
    price: 899.99,
    image: "/products/compressor-copeland-ac.jpg",
    category: "Air Conditioning",
    subcategory": "Compressors",
    stock: 22,
    rating: 4.7,
    reviewCount: 19,
    features: [
      "High seasonal efficiency",
      "Low oil circulation rate",
      "Internal pressure relief",
      "Centrifugal oil pump"
    ],
    specs: {
      "Capacity": "42,000 BTU/h",
      "Voltage": "200-230/3/60",
      "Refrigerant": "R-410A",
      "Connection": "Stub tubes"
    },
    slug: "copeland-scroll-compressor-zr42k3e",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ac-005",
    name: "Marsan Fan Motor 1/3 HP",
    description: "PSC condenser fan motor for air conditioning and heat pump applications. Enclosed frame for outdoor use.",
    price: 119.99,
    image: "/products/fan-motor-marsan.jpg",
    category: "Air Conditioning",
    subcategory": "Fan Motors",
    stock: 31,
    rating: 4.5,
    reviewCount: 23,
    features: [
      "Enclosed frame design",
      "Thermal overload protection",
      "Ball bearings",
      "Universal mounting"
    ],
    specs: {
      "Horsepower": "1/3 HP",
      "Voltage": "208-230V",
      "Speed": "1075 RPM",
      "Frame": "48Y"
    },
    slug: "marsan-fan-motor-1-3-hp",
    isFeatured: false,
    isNew: true
  },
  {
    id: "ac-006",
    name: "Single Run Capacitor 5 MFD 370V",
    description: "Single run capacitor for fan motors in air conditioning systems. Metallized polypropylene film design.",
    price: 12.99,
    image: "/products/capacitor-single.jpg",
    category: "Air Conditioning",
    subcategory": "Capacitors",
    stock: 94,
    rating: 4.4,
    reviewCount: 56,
    features: [
      "Metallized polypropylene film",
      "Pressure sensitive interrupter",
      "UL 810 certified",
      "Self-healing property"
    ],
    specs: {
      "Capacitance": "5 MFD ±6%",
      "Voltage": "370V AC",
      "Frequency": "50/60 Hz",
      "Terminals": "Quick connect"
    },
    slug: "single-run-capacitor-5-mfd-370v",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ac-007",
    name: "Honeywell L4006A Contactor",
    description: "2-pole definite purpose contactor for air conditioning and refrigeration applications. 24VAC coil.",
    price: 24.99,
    image: "/products/contactor-honeywell.jpg",
    category: "Air Conditioning",
    subcategory": "Contactors",
    stock: 67,
    rating: 4.6,
    reviewCount: 31,
    features: [
      "Double break contacts",
      "Silver cadmium oxide contacts",
      "Class B insulation",
      "Mechanically linked contacts"
    ],
    specs: {
      "Poles": "2",
      "Amperage": "30A",
      "Voltage": "600V AC",
      "Coil": "24VAC",
      "Auxiliary Contacts": "None"
    },
    slug: "honeywell-contactor-l4006a",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ac-008",
    name: "Trion Air Bear CB Commercial Air Filter",
    description: "Pleated panel air filter for commercial HVAC systems. MERV 8 rating for effective particle capture.",
    price: 18.99,
    image: "/products/filter-trion.jpg",
    category: "Air Conditioning",
    subcategory": "Filters",
    stock: 43,
    rating: 4.5,
    reviewCount: 19,
    features: [
      "MERV 8 rating",
      "Pleated design",
      "Metal frame",
      "Graduated density media"
    ],
    specs: {
      "Size": "20x20x4",
      "MERV Rating": "8",
      "Airflow Resistance": "0.29\" w.g. @ 500 FPM",
      "Media": "Synthetic blend"
    },
    slug: "trion-air-filter-cb",
    isFeatured: false,
    isNew: true
  },
  {
    id: "ac-009",
    name: "Honeywell T6 Pro Thermostat",
    description: "Programmable thermostat for heating and cooling systems. Wi-Fi capable with RedLINK technology.",
    price: 199.99,
    image: "/products/thermostat-honeywell.jpg",
    category: "Air Conditioning",
    subcategory": "Thermostats",
    stock: 28,
    rating: 4.7,
    reviewCount: 37,
    features: [
      "7-day programmable",
      "Wi-Fi remote control",
      "Smart response technology",
      "Filter change reminders",
      "Auto changeover"
    ],
    specs: {
      "Temperature Range": "40°F to 90°F",
      "Stages": "2 Heat/2 Cool",
      "Power": "Battery or hardwire",
      "Connectivity": "Wi-Fi, RedLINK"
    },
    slug: "honeywell-t6-pro-thermostat",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ac-010",
    name: "Refrigerant R-410A 25lb Cylinder",
    description: "R-410A refrigerant for air conditioning and heat pump applications. Non-ozone depleting HFC blend.",
    price: 199.99,
    image: "/products/refrigerant-r410a.jpg",
    category: "Air Conditioning",
    subcategory": "Refrigerants",
    stock: 26,
    rating: 4.5,
    reviewCount: 21,
    features: [
      "Near-azeotropic blend",
      "Non-ozone depleting",
      "High heat transfer coefficient",
      "GLIDE temperature glide <2°F"
    ],
    specs: {
      "Type": "R-410A (HFC blend)",
      "Weight": "25 lbs",
      "Purity": "≥99.5%",
      "Components": "R-32/125 (50/50%)"
    },
    slug: "refrigerant-r410a-25lb",
    isFeatured: false,
    isNew: false
  },
  {
    id: "ac-011",
    name: "Refrigerant R-32 10lb Cylinder",
    description: "R-32 refrigerant for air conditioning applications. Lower GWP alternative to R-410A with similar performance.",
    price: 89.99,
    image: "/products/refrigerant-r32.jpg",
    category: "Air Conditioning",
    subcategory": "Refrigerants",
    stock: 15,
    rating: 4.6,
    reviewCount: 14,
    features: [
      "Lower GWP (675 vs 2088 for R-410A)",
      "Higher heat transfer coefficient",
      "Lower refrigerant charge",
      "Easy to recycle"
    ],
    specs: {
      "Type": "R-32 (HFC)",
      "Weight": "10 lbs",
      "Purity": "≥99.8%",
      "Pressure Rating": "High pressure"
    },
    slug: "refrigerant-r32-10lb",
    isFeatured: false,
    isNew: true
  },

  // AUTOMOTIVE AIR CONDITIONING PRODUCTS
  {
    id: "auto-001",
    name: "Sanden SD7H15 Compressor",
    description: "OEM-style rotary automotive air conditioning compressor. Commonly used in passenger cars and light trucks.",
    price: 299.99,
    image: "/products/compressor-sanden.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Compressors",
    stock: 18,
    rating: 4.6,
    reviewCount: 22,
    features: [
      "OEM quality",
      "High efficiency",
      "Compact design",
      "Pre-filled with PAG oil"
    ],
    specs: {
      "Type": "Rotary",
      "Displacement": "150cc",
      "Voltage": "12V",
      "Refrigerant": "R-134a",
      "Mounting": "Ear mount"
    },
    slug: "sanden-compressor-sd7h15",
    isFeatured: true,
    isNew: false
  },
  {
    id: "auto-002",
    name: "TYO Radiator Condenser",
    description: "Automotive A/C condenser designed as direct replacement for OEM units. Aluminum construction for efficient heat transfer.",
    price: 149.99,
    image: "/products/condenser-tyo.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Condensers",
    stock: 24,
    rating: 4.5,
    reviewCount: 18,
    features: [
      "Aluminum construction",
      "High efficiency design",
      "Corrosion resistant coating",
      "Exact OEM fit"
    ],
    specs: {
      "Core Size": "28\" x 14\" x 3/4\"",
      "Inlet/Outlet": "3/8\"",
      "Refrigerant": "R-134a",
      "Application": "Universal fit"
    },
    slug: "tyo-condenser",
    isFeatured: false,
    isNew: true
  },
  {
    id: "auto-003",
    name: "Denso Evaporator Core",
    description: "Automotive A/C evaporator core for heat exchange in the vehicle cabin. High efficiency design.",
    price: 179.99,
    image: "/products/evaporator-denso.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Evaporators",
    stock: 15,
    rating: 4.7,
    reviewCount: 14,
    features: [
      "High efficiency design",
      "Anti-corrosion coating",
      "Exact OEM specifications",
      "Easy installation"
    ],
    specs: {
      "Core Size": "12\" x 8\" x 3\"",
      "Inlet/Outlet": "1/2\"",
      "Refrigerant": "R-134a",
      "Application": "Universal fit"
    },
    slug: "deno-evaporator-core",
    isFeatured: false,
    isNew: false
  },
  {
    id: "auto-004",
    name: "Receiver Drier 3.5\" X 8\"",
    description: "Automotive A/C receiver/drier with moisture indicator and service ports. Protects system from contaminants.",
    price: 34.99,
    image: "/products/receiver-drier.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Receiver Driers",
    stock: 38,
    rating: 4.4,
    reviewCount: 26,
    features: [
      "Desiccant cartridge",
      "Moisture indicator",
      "Inlet and outlet service ports",
      "10 micron filtration"
    ],
    specs: {
      "Diameter": "3.5\"",
      "Length": "8\"",
      "Refrigerant": "R-134a",
      "Desiccant": "XH-7 or equivalent"
    },
    slug: "receiver-drier-3-5x8",
    isFeatured: false,
    isNew: false
  },
  {
    id: "auto-005",
    name: "TXV Expansion Valve",
    description: "Thermostatic expansion valve for automotive A/C systems. Regulates refrigerant flow into evaporator.",
    price: 49.99,
    image: "/products/expansion-valve-txv.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Expansion Valves",
    stock: 22,
    rating: 4.6,
    reviewCount: 17,
    features: [
      "Precise superheat control",
      "External equalizer",
      "Stainless steel power element",
      "Hermetic seal"
    ],
    specs: {
      "Type": "TXV",
      "Capacity": "2-3 Ton",
      "Refrigerant": "R-134a",
      "Connection": "O-ring",
      "Superheat": "Adjustable"
    },
    slug: "txv-expansion-valve",
    isFeatured: false,
    isNew: true
  },
  {
    id: "auto-006",
    name: "BLW Motor Blower Assembly",
    description: "HVAC blower motor and wheel assembly for vehicle heating and air conditioning systems.",
    price: 89.99,
    image: "/products/blower-motor.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Blower Motors",
    stock: 31,
    rating: 4.5,
    reviewCount: 29,
    features: [
      "Complete assembly",
      "Pre-balanced wheel",
      "Multiple speed options",
      "Quiet operation"
    ],
    specs: {
      "Voltage": "12V",
      "Speeds": "3 or 4",
      "Airflow": "Up to 400 CFM",
      "Mounting": "Various configurations"
    },
    slug: "blower-motor-assembly",
    isFeatured: false,
    isNew: false
  },
  {
    id: "auto-007",
    name: "Barrier Hose 6ft #6 & #10",
    description: "Pre-made automotive A/C hose assembly with barrier technology. Includes fittings for easy installation.",
    price: 89.99,
    image: "/products/ac-hose-barrier.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "AC Hoses",
    stock: 19,
    rating: 4.5,
    reviewCount: 15,
    features: [
      "Barrier technology",
      "Pre-assembled",
      "R-134a compatible",
      "UV resistant coating"
    ],
    specs: {
      "Length": "6 feet",
      "Sizes": "#6 and #10",
      "Refrigerant": "R-134a",
      "Fittings": "Included",
      "Working Pressure": "500 PSI"
    },
    slug: "barrier-hose-6ft-6-10",
    isFeatured: false,
    isNew: true
  },
  {
    id: "auto-008",
    name: "AC Pro UV Leak Detector Kit",
    description: "Professional UV leak detection kit for automotive A/C systems. Includes UV light and fluorescent dye.",
    price: 39.99,
    image: "/products/uv-leak-detector.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Service Equipment",
    stock: 27,
    rating: 4.6,
    reviewCount: 23,
    features: [
      "UV light included",
      "Multiple dye bottles",
      "Yellow enhancing glasses",
      "Detects R-134a and R-1234yf"
    ],
    specs: {
      "UV Light": "12V DC powered",
      "Dye": "Concentrated formula",
      "Wavelength": "380-390nm",
      "Battery Life": "4+ hours"
    },
    slug: "ac-pro-uv-leak-detector-kit",
    isFeatured: false,
    isNew: false
  },
  {
    id: "auto-009",
    name: "Manifold Gauge Set R-134a",
    description: "Automotive A/C manifold gauge set designed specifically for R-134a refrigerant. Includes 60\" hoses.",
    price: 89.99,
    image: "/products/manifold-gauge-auto.jpg",
    category: "Automotive Air Conditioning",
    subcategory": "Service Equipment",
    stock: 16,
    rating: 4.7,
    reviewCount: 19,
    features: [
      "R-134a specific",
      "60\" barrier hoses",
      "Easy-to-read gauges",
      "Quick connect couplers"
    ],
    specs: {
      "Refrigerant": "R-134a only",
      "Low Side": "0-150 PSI",
      "High Side": "0-500 PSI",
      "Hose Length": "60 inches",
      "Couplers": "Quick connect"
    },
    slug: "manifold-gauge-set-r134a",
    isFeatured: false,
    isNew: false
  }
];