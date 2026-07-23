import { MotionProps, motion } from "framer-motion";
import { 
  Phone, 
  MapPin, 
  Mail
} from "lucide-react";

export function Footer() {
  return (
    <footer className="bg-navy text-white/90 py-12">
      <div className="max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Logo & Description */}
          <div>
            <div className="flex items-center space-x-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center">
                <div className="w-full h-full grid grid-cols-2">
                  <div className="bg-primary rounded-l-lg"></div>
                  <div className="bg-navy rounded-r-lg">
                    <div className="h-4 w-4 mx-auto my-1 bg-white rounded"></div>
                    <div className="h-4 w-4 mx-auto my-1 bg-white rounded"></div>
                  </div>
                </div>
              </div>
              <div>
                <p className="text-navy font-bold text-xs text-uppercase">N&D'S</p>
                <p className="text-primary font-semibold text-xs">AIR CONDITIONING</p>
                <p className="text-navy font-light text-xs">AND REFRIGERATION SERVICES</p>
              </div>
            </div>
            <p className="text-white/80 mb-6">
              Expert HVAC, refrigeration, auto AC, and washing machine/dryer repair and installation services.
            </p>
            <div className="flex space-x-4">
              <a href="#" className="text-white/70 hover:text-white transition-colors">
                <Phone className="w-5 h-5" />
              </a>
              <a href="#" className="text-white/70 hover:text-white transition-colors">
                <MapPin className="w-5 h-5" />
              </a>
              <a href="#" className="text-white/70 hover:text-white transition-colors">
                <Mail className="w-5 h-5" />
              </a>
            </div>
          </div>
          
          {/* Quick Links */}
          <div>
            <h3 className="font-semibold mb-4 text-white">Quick Links</h3>
            <ul className="space-y-2">
              <li>
                <a href="#services" className="text-white/70 hover:text-white transition-colors">
                  Services
                </a>
              </li>
              <li>
                <a href="#process" className="text-white/70 hover:text-white transition-colors">
                  Process
                </a>
              </li>
              <li>
                <a href="#service-area" className="text-white/70 hover:text-white transition-colors">
                  Service Area
                </a>
              </li>
              <li>
                <a href="#testimonials" className="text-white/70 hover:text-white transition-colors">
                  Testimonials
                </a>
              </li>
              <li>
                <a href="#contact" className="text-white/70 hover:text-white transition-colors">
                  Contact
                </a>
              </li>
            </ul>
          </div>
          
          {/* Services */}
          <div>
            <h3 className="font-semibold mb-4 text-white">Our Services</h3>
            <ul className="space-y-2">
              <li>
                <a href="#services" className="text-white/70 hover:text-white transition-colors">
                  HVAC
                </a>
              </li>
              <li>
                <a href="#services" className="text-white/70 hover:text-white transition-colors">
                  Refrigeration
                </a>
              </li>
              <li>
                <a href="#services" className="text-white/70 hover:text-white transition-colors">
                  AC
                </a>
              </li>
              <li>
                <a href="#services" className="text-white/70 hover:text-white transition-colors">
                  Washer/Dryer
                </a>
              </li>
            </ul>
          </div>
          
          {/* Contact Info & Newsletter */}
          <div className="space-y-4">
            <h3 className="font-semibold mb-4 text-white">Contact Info</h3>
            <p className="text-white/70 mb-2">
              <span className="flex items-center space-x-2">
                <Phone className="w-4 h-4" />
                (868) 707-4646
              </span>
            </p>
            <p className="text-white/70 mb-2">
              <span className="flex items-center space-x-2">
                <MapPin className="w-4 h-4" />
                Warden Road, East Street Extension, St. Clair Circ Ave
              </span>
            </p>
            <p className="text-white/70 mb-2">
              <span className="flex items-center space-x-2">
                <Mail className="w-4 h-4" />
                nsairconditioning@gmail.com
              </span>
            </p>
            <h3 className="font-semibold mb-3 text-white">Newsletter</h3>
            <form className="flex space-x-2">
              <input
                type="email"
                placeholder="Enter your email"
                className="flex-1 px-4 py-2 bg-navy/80 border border-navy/60 rounded-l-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary text-white placeholder-white/60"
              />
              <button type="submit" className="bg-primary text-navy font-semibold px-4 py-2 rounded-r-xl hover:bg-primary/90 transition-colors">
                Subscribe
              </button>
            </form>
          </div>
        </div>
        
        {/* Bottom border and copyright */}
        <div className="mt-12 pt-8 border-t border-navy/30">
          <div className="flex flex-col items-center text-center space-y-4">
            <p className="text-white/60 text-sm">
              &copy; {new Date().getFullYear()} N&D's Air Conditioning and Refrigeration Services. All rights reserved.
            </p>
            <div className="flex space-x-4">
              <a href="#" className="text-white/70 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z" />
                </svg>
              </a>
              <a href="#" className="text-white/70 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M23 3a10.9 10.9 0 01-3.14 1.53 4.48 4.48 0 00-7.86 3v1A10.66 10.66 0 013 4s-4 9 5 13a11.64 11.64 0 01-7 2c9 5 20 0 20-11.5a4.5 4.5 0 00-.08-.31A10.66 10.66 0 0023 3z" />
                </svg>
              </a>
              <a href="#" className="text-white/70 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2-2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012-2h2a2 2 0 01-2-2z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
