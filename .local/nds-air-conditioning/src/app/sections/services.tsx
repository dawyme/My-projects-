'use client';
import { MotionProps, motion } from "framer-motion";
import {
  Wind,
  Snowflake,
  Car,
  ArrowRight
} from "lucide-react";

export function Services() {
  return (
    <section id="services" className="py-20 bg-white dark:bg-navy/90">
      <div className="max-w-7xl mx-auto px-6">
        <h2 className="text-4xl md:text-5xl font-bold text-center mb-12 text-navy dark:text-white">
          Our Services
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {/* HVAC */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-200px" }}
            transition={{ duration: 0.8 }}
          >
            <div className="bg-gray-soft dark:bg-navy/80 p-8 rounded-xl border border-navy/20">
              <div className="w-16 h-16 mb-6 flex items-center justify-center bg-primary/20 rounded-xl">
                <Wind className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-2xl font-semibold mb-4 text-navy dark:text-white">
                HVAC Solutions
              </h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                Expert installation, repair, and maintenance of heating, ventilation, and air conditioning systems for residential, commercial, and industrial applications.
              </p>
              <a href="#contact" className="inline-flex items-center px-4 py-2 bg-navy text-white text-sm font-medium rounded hover:bg-primary/20 transition-colors">
                Learn More
                <ArrowRight className="ml-2 w-4 h-4" />
              </a>
            </div>
          </motion.div>

          {/* Refrigeration */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-200px" }}
            transition={{ delay: 0.2, duration: 0.8 }}
          >
            <div className="bg-gray-soft dark:bg-navy/80 p-8 rounded-xl border border-navy/20">
              <div className="w-16 h-16 mb-6 flex items-center justify-center bg-primary/20 rounded-xl">
                <Snowflake className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-2xl font-semibold mb-4 text-navy dark:text-white">
                Commercial & Residential Refrigeration
              </h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                Specialized services for refrigeration systems including walk-in coolers, freezers, display cases, and industrial refrigeration equipment.
              </p>
              <a href="#contact" className="inline-flex items-center px-4 py-2 bg-navy text-white text-sm font-medium rounded hover:bg-primary/20 transition-colors">
                Learn More
                <ArrowRight className="ml-2 w-4 h-4" />
              </a>
            </div>
          </motion.div>

          {/* Auto AC */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-200px" }}
            transition={{ delay: 0.4, duration: 0.8 }}
          >
            <div className="bg-gray-soft dark:bg-navy/80 p-8 rounded-xl border border-navy/20">
              <div className="w-16 h-16 mb-6 flex items-center justify-center bg-primary/20 rounded-xl">
                <Car className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-2xl font-semibold mb-4 text-navy dark:text-white">
                Automotive Air Conditioning
              </h3>
              <p className="text-gray-600 dark:text-gray-300 mb-6">
                Professional automotive AC repair, recharge, and maintenance for cars, trucks, and fleet vehicles to keep you cool on the road.
              </p>
              <a href="#contact" className="inline-flex items-center px-4 py-2 bg-navy text-white text-sm font-medium rounded hover:bg-primary/20 transition-colors">
                Learn More
                <ArrowRight className="ml-2 w-4 h-4" />
              </a>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}