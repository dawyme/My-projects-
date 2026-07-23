'use client';
import { MotionProps, motion } from "framer-motion";
import {
  Phone,
  MapPin,
  Mail,
  MessageCircle,
  Clock,
  AlertTriangle,
  Map,
  ArrowRight
} from "lucide-react";

export function Contact() {
  return (
    <section id="contact" className="py-20 bg-white dark:bg-navy/90">
      <div className="max-w-7xl mx-auto px-6">
        {/* Emergency Service Banner */}
        <div className="mb-8 bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4">
          <div className="flex items-start space-x-4">
            <div className="flex-shrink-0">
              <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5" />
            </div>
            <div>
              <h3 className="font-semibold text-red-800 dark:text-red-200">
                24/7 Emergency Service
              </h3>
              <p className="mt-1 text-red-700 dark:text-red-300">
                We're available around the clock for emergency HVAC, refrigeration, and AC repairs.
                <br />
                Call now: <a href="tel:+18687074646" className="font-bold underline">(868) 707-4646</a>
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
          {/* Contact Info */}
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-200px" }}
            transition={{ duration: 0.8 }}
          >
            <div className="space-y-8">
              <h2 className="text-4xl md:text-5xl font-bold text-navy dark:text-white">
                Get in Touch
              </h2>
              <p className="text-gray-600 dark:text-gray-400 mb-6">
                Ready to discuss your HVAC or refrigeration project? Our team of experts is here to help you achieve optimal climate control for your facility.
              </p>

              {/* Quick Contact Buttons */}
              <div className="space-y-4">
                {/* Call Now Button */}
                <a
                  href="tel:+18687074646"
                  className="w-full flex items-center justify-center px-6 py-4 bg-primary text-white text-lg font-semibold rounded-lg hover:bg-primary/90 transition-all duration-300 transform hover:-scale-105 shadow-md hover:shadow-lg border border-white/20"
                >
                  <Phone className="mr-3 h-5 w-5" />
                  Call Now: (868) 707-4646
                </a>
              </div>

              <div className="space-y-4">
                {/* WhatsApp Button */}
                <a
                  href="https://wa.me/18687074646"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center px-6 py-4 bg-green-500 text-white text-lg font-semibold rounded-lg hover:bg-green-600 transition-all duration-300 transform hover:-scale-105"
                >
                  <MessageCircle className="mr-3 h-5 w-5" />
                  WhatsApp Us: (868) 707-4646
                </a>
              </div>

              {/* Business Hours */}
              <div className="space-y-3">
                <h3 className="font-semibold text-navy dark:text-white">Business Hours</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span>Monday - Friday:</span>
                    <span className="text-right">8:00 AM - 6:00 PM</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Saturday:</span>
                    <span className="text-right">9:00 AM - 1:00 PM</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Sunday:</span>
                    <span className="text-right">Closed</span>
                  </div>
                  <div className="flex justify-between mt-2 pt-2 border-t">
                    <span className="font-medium">Emergency Service:</span>
                    <span className="text-red-600 font-medium text-right">24/7</span>
                  </div>
                </div>
              </div>

              {/* Contact Details */}
              <div className="space-y-6">
                <div className="flex items-start space-x-4">
                  <div className="w-10 h-10 flex items-center justify-center bg-primary/20 rounded-xl shrink-0">
                    <Phone className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-navy dark:text-white">Call Us</h3>
                    <p className="text-gray-700 dark:text-gray-400">
                      <a href="tel:+18687074646" className="text-navy dark:text-primary hover:underline">(868) 707-4646</a>
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-4">
                  <div className="w-10 h-10 flex items-center justify-center bg-primary/20 rounded-xl shrink-0">
                    <MapPin className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-navy dark:text-white">Visit Us</h3>
                    <p className="text-gray-700 dark:text-gray-400">
                      Warden Road, East Street Extension, St. Clair Circ Ave
                    </p>
                  </div>
                </div>
                <div className="flex items-start space-x-4">
                  <div className="w-10 h-10 flex items-center justify-center bg-primary/20 rounded-xl shrink-0">
                    <Mail className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-navy dark:text-white">Email Us</h3>
                    <p className="text-gray-700 dark:text-gray-400">
                      <a href="mailto:ndsairconditioning@gmail.com" className="text-navy dark:text-primary hover:underline">
                        ndsairconditioning@gmail.com
                      </a>
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Contact Form & Map */}
          <motion.div
            initial={{ opacity: 0, x: 50 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-200px" }}
            transition={{ delay: 0.4, duration: 0.8 }}
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              {/* Contact Form */}
              <div className="bg-gray-soft dark:bg-navy/80 rounded-xl p-8 border border-navy/20">
                <h3 className="text-2xl font-semibold mb-6 text-navy dark:text-white">
                  Request a Quote or Service
                </h3>
                <form className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-navy dark:text-white mb-2">
                        Full Name
                      </label>
                      <input
                        type="text"
          required
          className="w-full px-4 py-3 border border-navy/30 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-white dark:bg-navy/70 text-navy dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-navy dark:text-white mb-2">
                        Email Address
                      </label>
                      <input
                        type="email"
          required
          className="w-full px-4 py-3 border border-navy/30 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-white dark:bg-navy/70 text-navy dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-navy dark:text-white mb-2">
                        Phone Number
                      </label>
                      <input
                        type="tel"
          className="w-full px-4 py-3 border border-navy/30 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-white dark:bg-navy/70 text-navy dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-navy dark:text-white mb-2">
                        Service Type
                      </label>
                      <select
            className="w-full px-4 py-3 border border-navy/30 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-white dark:bg-navy/70 text-navy dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
          >
                        <option value="">Select Service Type</option>
                        <option value="hvac">HVAC</option>
                        <option value="refrigeration">Refrigeration</option>
                        <option value="auto-ac">Auto AC</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-navy dark:text-white mb-2">
                      How Can We Help?
                    </label>
                    <textarea
              rows={4}
              required
              className="w-full px-4 py-3 border border-navy/30 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary bg-white dark:bg-navy/70 text-navy dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
            />
                  </div>
                  <div className="pt-4">
                    <button
                      type="submit"
                      className="w-full bg-navy text-white py-3 px-6 rounded-xl font-semibold hover:bg-primary/20 transition-colors duration-300 transform hover:-translate-y-1 shadow-md hover:shadow-lg"
                    >
                      Send Message
                      <ArrowRight className="ml-2 w-4 h-4" />
                    </button>
                  </div>
                </form>
              </div>

              {/* Google Maps Placeholder */}
              <div className="aspect-w-16 aspect-h-9 rounded-xl overflow-hidden shadow-lg bg-gray-200">
                <div className="flex h-full w-full items-center justify-center bg-gray-300">
                  <div className="text-center p-4">
                    <Map className="h-6 w-6 mb-3 text-gray-500" />
                    <h3 className="font-semibold text-gray-700 mb-2">Our Location</h3>
                    <p className="text-sm text-gray-600">
                      Warden Road, East Street Extension, St. Clair Circ Ave
                    </p>
                    <p className="text-xs text-gray-500 mt-2">
                      (Map placeholder - integrate Google Maps API in production)
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}