'use client';

import { useRouter } from 'next/navigation';
import { CheckCircle, Truck, Clock, MessageCircle, User } from 'lucide-react';

export default function OrderConfirmationPage() {
  const router = useRouter();

  // In a real app, you would get order data from URL params or context
  const orderNumber = `NDS-${Math.floor(Math.random() * 90000) + 10000}`;
  const orderDate = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const estimatedDelivery = new Date();
  estimatedDelivery.setDate(estimatedDelivery.getDate() + 5); // 5 days from now

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gray-50 py-12">
      <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <div className="mb-8">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-green-100 mb-4">
            <CheckCircle className="h-6 w-6 text-green-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Order Confirmed!
          </h1>
          <p className="text-gray-600 mb-6">
            Thank you for your purchase. Your order has been successfully processed.
          </p>
        </div>

        <div className="space-y-6">
          {/* Order Details */}
          <div className="text-left">
            <h2 className="text-xl font-bold mb-4">Order Details</h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600">Order Number:</span>
                <span className="font-mono">{orderNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Order Date:</span>
                <span>{orderDate}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Estimated Delivery:</span>
                <span>{estimatedDelivery.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric'
                })}</span>
              </div>
            </div>
          </div>

          {/* What Happens Next */}
          <div className="text-left">
            <h2 className="text-xl font-bold mb-4">What Happens Next</h2>
            <div className="space-y-5">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <User className="h-4 w-4 text-primary mt-0.5" />
                </div>
                <div className="ml-3">
                  <h3 className="font-semibold">Order Processing</h3>
                  <p className="text-gray-600">
                    Our team will review your order and begin preparing it for shipment.
                  </p>
                </div>
              </div>

              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <Truck className="h-4 w-4 text-primary mt-0.5" />
                </div>
                <div className="ml-3">
                  <h3 className="font-semibold">Shipping & Delivery</h3>
                  <p className="text-gray-600">
                    Your order will be shipped via our trusted carriers. You'll receive
                    tracking information via email once it's available.
                  </p>
                </div>
              </div>

              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <MessageCircle className="h-4 w-4 text-primary mt-0.5" />
                </div>
                <div className="ml-3">
                  <h3 className="font-semibold">Customer Support</h3>
                  <p className="text-gray-600">
                    If you have any questions about your order, please contact our
                    customer service team at (868) 707-4646 or email support@ndsac.com.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-10">
          <button
            onClick={() => router.push('/')}
            className="w-full bg-primary text-white px-6 py-3 rounded-lg hover:bg-primary/90
              transition-all duration-300 flex items-center justify-center gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Continue Shopping
          </button>
        </div>
      </div>
    </div>
  );
}