'use client';
import { MotionProps, motion } from "framer-motion";

export function Stats() {
  const stats = [
    { number: "15+", label: "Years of Experience" },
    { number: "5,000+", label: "Jobs Completed" },
    { number: "24/7", label: "Emergency Response" },
    { number: "98%", label: "Customer Satisfaction" },
  ];

  const staggerChildren = {
    hidden: { opacity: 0, y: 20 },
    show: {
      opacity: 1,
      y: 0,
      transition: {
        staggerChildren: 0.1,
      },
    },
  };

  return (
    <section className="py-20 bg-white dark:bg-navy/90">
      <div className="max-w-7xl mx-auto px-6">
        <h2 className="text-4xl md:text-5xl font-bold text-center mb-12 text-navy dark:text-white">
          Why Choose N&D's?
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 text-center">
          {stats.map((stat, index) => (
            <motion.div
              key={index}
              variants={staggerChildren}
              initial="hidden"
              animate="show"
            >
              <div className="flex items-center justify-center mb-4">
                <div className="w-14 h-14 flex items-center justify-center bg-primary/10 rounded-xl">
                  <span className="text-4xl font-bold text-primary">{stat.number}</span>
                </div>
              </div>
              <p className="text-lg font-medium text-navy dark:text-white">
                {stat.label}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
