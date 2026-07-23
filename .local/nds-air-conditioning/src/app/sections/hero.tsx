'use client';

import { motion } from "framer-motion";
import {
  Snowflake,
  Settings,
  Fan,
  Aperture,
  ArrowRight,
  Phone
} from "lucide-react";

export function Hero() {
  return (
    <section className="relative h-[100vh] w-full bg-navy overflow-hidden">
      {/* Animated gradient background */}
      <div className="absolute inset-0 bg-gradient-to-b from-navy/90 via-primary/70 to-navy/90"></div>

      {/* Floating icons */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-10 left-10">
          <motion.div
            style={{
              animation: 'float 6s ease-in-out infinite'
            }}
          >
            <Snowflake className="w-8 h-8 text-primary/50" />
          </motion.div>
        </div>
        <div className="absolute top-20 right-10">
          <motion.div
            style={{
              animation: 'float 6s ease-in-out infinite 2s'
            }}
          >
            <Settings className="w-8 h-8 text-primary/50" />
          </motion.div>
        </div>
        <div className="absolute bottom-10 left-10">
          <motion.div
            style={{
              animation: 'float 6s ease-in-out infinite 1s'
            }}
          >
            <Fan className="w-8 h-8 text-primary/50" />
          </motion.div>
        </div>
        <div className="absolute bottom-20 right-10">
          <motion.div
            style={{
              animation: 'float 6s ease-in-out infinite 3s'
            }}
          >
            <Aperture className="w-8 h-8 text-primary/50" /> {/* Approximation for washer drum */}
          </motion.div>
        </div>
      </div>

      {/* Content */}
      <div className="relative h-full flex flex-col items-start justify-center px-6 pt-20 pb-10 text-white z-10">
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tighter mb-6 leading-none bg-clip-text text-transparent bg-gradient-to-r from-primary to-white bg-[length:200%_100%] animate-[gradient-shift_3s_ease-in-out_infinite]">
          Cooling & Comfort, Engineered
        </h1>
        <p className="text-xl md:text-2xl lg:text-3xl font-light max-w-2xl mb-8 bg-clip-text text-transparent bg-gradient-to-r from-white to-primary bg-[length:200%_100%] animate-[gradient-shift_3s_ease-in-out_infinite_delay-1000]">
          Expert HVAC, refrigeration, auto AC, and washing machine/dryer repair and installation services.
        </p>
        <div className="flex space-x-4">
          <Link href="/products" className="flex h-14 px-8 items-center justify-center gap-3 bg-primary text-navy font-semibold hover:bg-primary/90 transition-all duration-300 transform hover:-translate-y-1 shadow-lg">
            Browse Products
            <ArrowRight className="w-5 h-5" />
          </Link>
          <a href="tel:+18687074646" className="flex h-14 px-8 items-center justify-center gap-3 border border-white/20 text-white hover:bg-white/10 backdrop-blur-sm transition-all duration-300 transform hover:-translate-y-1">
            <Phone className="w-5 h-5" />
            Call (868) 707-4646
          </a>
        </div>
      </div>

      {/* Decorative elements */}
      <div className="absolute bottom-0 left-0 w-full h-[200px] bg-[radial-gradient(at_bottom,_transparent_0%,rgba(10,31,68,0.8)_100%)] pointer-events-none"></div>
    </section>
  );
}