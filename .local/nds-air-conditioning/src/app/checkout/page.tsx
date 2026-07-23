'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCartContext } from '@/context/CartContext';
import {
  MapPin,
  Truck,
  User,
  Phone,
  Mail,
  Clock,
  CheckCircle,
  AlertTriangle,
  Bank,
  CreditCard,
  Layout,
  MessageSquare,
  DollarSign,
  Percent
} from 'lucide-react';

export default function CheckoutPage() {
  const router = useRouter();
  const { cartItems, clearCart } = useCartContext();
  const [step, setStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('');

  // Form state
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    specialInstructions: ''
  });

  // Validation
  const validateStep1 = () => {
    return (
      formData.firstName.trim() !== '' &&
      formData.lastName.trim() !== '' &&
      formData.email.trim() !== '' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email) &&
      formData.phone.trim() !== ''
    );
  };

  const validateStep2 = () => {
    return (
      formData.address.trim() !== '' &&
      formData.city.trim() !== '' &&
      formData.state.trim() !== '' &&
      formData.zipCode.trim() !== '' &&
      /^\d{5}(-\d{4})?$/.test(formData.zipCode)
    );
  };

  const handleNext = () => {
    if (step === 1 && !validateStep1()) {
      alert('Please fill in all required fields correctly.');
      return;
    }

    if (step === 2 && !validateStep2()) {
      alert('Please fill in all address fields correctly.');
      return;
    }

    if (step < 3) {
      setStep(prev => prev + 1);
    }
  };

  const handlePrevious = () => {
    if (step > 1) {
      setStep(prev => prev - 1);
    }
  };

  const handlePlaceOrder = async () => {
    if (!paymentMethod) {
      alert('Please select a payment method.');
      return;
    }

    setIsProcessing(true);

    // Simulate payment processing
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Clear cart after successful order
      clearCart();

      // Redirect to order confirmation
      router.push('/order-confirmation');
    } catch (error) {
      alert('There was an error processing your payment. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  if (cartItems.length === 0) {
    router.push('/');
    return null;
  }

  // Calculate totals
  const subtotal = cartItems.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );
  const tax = subtotal * 0.0825; // 8.25% tax rate
  const total = subtotal + tax;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* Progress Indicator */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-2xl font-bold text-gray-900">
              Checkout
            </h1>
            <div className="flex items-center space-x-4 text-sm">
              {[1, 2, 3].map(stepNum => (
                <div key={stepNum} className="flex items-center">
                  <div className={`w-3 h-3 rounded-full
                    ${step >= stepNum ? 'bg-primary' : 'bg-gray-300'}`} />
                  {stepNum < 3 && (
                    <div className="mx-2 h-0.5 w-4 bg-gray-300" />
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex w-full space-x-4">
            <div className={`flex-1 flex items-center p-3 border rounded-lg
              ${step === 1 ? 'bg-primary/10 border-primary' : 'border-gray-200'}`}>
              <User className="mr-3 h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-gray-900">Contact Information</p>
                <p className="text-sm text-gray-500">
                  {step >= 1 && step <= 3 ? 'Complete' : 'Pending'}
                </p>
              </div>
            </div>
            <div className={`flex-1 flex items-center p-3 border rounded-lg
              ${step === 2 ? 'bg-primary/10 border-primary' : 'border-gray-200'}`}>
              <MapPin className="mr-3 h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-gray-900">Shipping Information</p>
                <p className="text-sm text-gray-500">
                  {step >= 2 && step <= 3 ? 'Complete' : 'Pending'}
                </p>
              </div>
            </div>
            <div className={`flex-1 flex items-center p-3 border rounded-lg
              ${step === 3 ? 'bg-primary/10 border-primary' : 'border-gray-200'}`}>
              <CreditCard className="mr-3 h-5 w-5 text-primary" />
              <div>
                <p className="font-medium text-gray-900">Payment & Review</p>
                <p className="text-sm text-gray-500">
                  {step === 3 ? 'Active' : 'Pending'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Step 1: Contact Information */}
        {step === 1 && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold mb-4">Contact Information</h2>
            <form onSubmit={(e) => e.preventDefault()}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    First Name
                  </label>
                  <input
                    type="text"
                    value={formData.firstName}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, firstName: e.target.value }))
                    }
                    placeholder="John"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Last Name
                  </label>
                  <input
                    type="text"
                    value={formData.lastName}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, lastName: e.target.value }))
                    }
                    placeholder="Doe"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, email: e.target.value }))
                    }
                    placeholder="you@example.com"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, phone: e.target.value }))
                    }
                    placeholder="(555) 123-4567"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>
              </div>

              <div className="mt-6">
                <button
                  type="button"
                  onClick={handleNext}
                  className="w-full bg-primary text-white px-6 py-3 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  Continue to Shipping
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 2: Shipping Information */}
        {step === 2 && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold mb-4">Shipping Information</h2>
            <div className="mb-4">
              <div className="flex items-center">
                <input
                  type="radio"
                  id="shipping-home"
                  name="deliveryMethod"
                  checked={formData.deliveryMethod === 'home'}
                  onChange={(e) =>
                    setFormData(prev => ({ ...prev, deliveryMethod: e.target.value }))
                  }
                  className="h-4 w-4 text-primary"
                />
                <label className="ml-2 font-medium text-gray-700" for="shipping-home">
                  Home Delivery
                </label>
              </div>
              <p className="mt-1 text-sm text-gray-500">
                Standard shipping within 3-5 business days
              </p>
            </div>

            <div className="mb-4">
              <div className="flex items-center">
                <input
                  type="radio"
                  id="shipping-pickup"
                  name="deliveryMethod"
                  checked={formData.deliveryMethod === 'pickup'}
                  onChange={(e) =>
                    setFormData(prev => ({ ...prev, deliveryMethod: e.target.value }))
                  }
                  className="h-4 w-4 text-primary"
                />
                <label className="ml-2 font-medium text-gray-700" for="shipping-pickup">
                  Store Pickup
                </label>
              </div>
              <p className="mt-1 text-sm text-gray-500">
                Free pickup at our main location: 123 Industrial Ave, Port of Spain
              </p>
            </div>

            <form onSubmit={(e) => e.preventDefault()}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Street Address
                  </label>
                  <input
                    type="text"
                    value={formData.address}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, address: e.target.value }))
                    }
                    placeholder="123 Main Street"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Apartment, Suite, etc. (optional)
                  </label>
                  <input
                    type="text"
                    value={formData.address2}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, address2: e.target.value }))
                    }
                    placeholder="Apt 4B"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    City
                  </label>
                  <input
                    type="text"
                    value={formData.city}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, city: e.target.value }))
                    }
                    placeholder="Port of Spain"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    State/Province
                  </label>
                  <input
                    type="text"
                    value={formData.state}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, state: e.target.value }))
                    }
                    placeholder="Trinidad"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    ZIP / Postal Code
                  </label>
                  <input
                    type="text"
                    value={formData.zipCode}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, zipCode: e.target.value }))
                    }
                    placeholder="12345"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                    required
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Special Instructions (optional)
                  </label>
                  <textarea
                    value={formData.specialInstructions}
                    onChange={(e) =>
                      setFormData(prev => ({ ...prev, specialInstructions: e.target.value }))
                    }
                    rows="4"
                    placeholder="Leave any special instructions for delivery or pickup..."
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
                  />
                </div>
              </div>

              <div className="flex justify-between mt-6">
                <button
                  type="button"
                  onClick={handlePrevious}
                  className="px-6 py-2 bg-gray-200 text-gray-900 rounded-lg hover:bg-gray-300 transition-colors"
                >
                  Previous
                </button>

                <button
                  type="button"
                  onClick={handleNext}
                  className="bg-primary text-white px-6 py-3 rounded-lg hover:bg-primary/90 transition-colors"
                >
                  Continue to Payment
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 3: Payment & Review */}
        {step === 3 && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold mb-4">Payment & Review</h2>

            {/* Order Summary */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-4">Order Summary</h3>
              <div className="space-y-4">
                {cartItems.map(item => (
                  <div key={item.id} className="flex justify-between items-start pt-3 border-t">
                    <div className="flex items-start space-x-3">
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-16 h-16 object-cover rounded-lg"
                      />
                      <div>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-sm text-gray-500">
                          Quantity: {item.quantity}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">
                        ${(item.price * item.quantity).toFixed(2)}
                      </p>
                    </div>
                  </div>
                ))}

                <div className="pt-4 border-t">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Subtotal:</span>
                    <span className="font-medium">${subtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Tax (8.25%):</span>
                    <span className="font-medium">${tax.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between pt-2 font-semibold text-lg">
                    <span>Total:</span>
                    <span className="text-primary">${total.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Payment Methods */}
            <div className="mb-6">
              <h3 className="text-lg font-semibold mb-4">Payment Method</h3>
              <div className="space-y-4">
                <div className="border p-4 rounded-lg">
                  <div className="flex items-start space-x-3">
                    <Bank className="h-5 w-5 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">Bank Transfer</p>
                      <p className="text-sm text-gray-500">
                        Transfer funds to our business account. Order will ship after payment confirmation.
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center">
                    <input
                      type="radio"
                      id="payment-bank"
                      name="paymentMethod"
                      checked={paymentMethod === 'bank'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="h-4 w-4 text-primary"
                    />
                    <label className="ml-2 font-medium text-gray-700" for="payment-bank">
                      Bank Transfer
                    </label>
                  </div>
                </div>

                <div className="border p-4 rounded-lg">
                  <div className="flex items-start space-x-3">
                    <CreditCard className="h-5 w-5 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">Credit/Debit Card</p>
                      <p className="text-sm text-gray-500">
                        Secure payment via our payment gateway (coming soon)
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center">
                    <input
                      type="radio"
                      id="payment-card"
                      name="paymentMethod"
                      checked={paymentMethod === 'card'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="h-4 w-4 text-primary"
                    />
                    <label className="ml-2 font-medium text-gray-700" for="payment-card">
                      Credit/Debit Card
                    </label>
                  </div>
                </div>

                <div className="border p-4 rounded-lg">
                  <div className="flex items-start space-x-3">
                    <MessageSquare className="h-5 w-5 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">WhatsApp Order</p>
                      <p className="text-sm text-gray-500">
                        Send your order via WhatsApp to +1 (868) 707-4646 for manual processing
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center">
                    <input
                      type="radio"
                      id="payment-whatsapp"
                      name="paymentMethod"
                      checked={paymentMethod === 'whatsapp'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="h-4 w-4 text-primary"
                    />
                    <label className="ml-2 font-medium text-gray-700" for="payment-whatsapp">
                      WhatsApp Order
                    </label>
                  </div>
                </div>

                <div className="border p-4 rounded-lg">
                  <div className="flex items-start space-x-3">
                    <DollarSign className="h-5 w-5 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">PayPal</p>
                      <p className="text-sm text-gray-500">
                        Secure payment through PayPal (coming soon)
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center">
                    <input
                      type="radio"
                      id="payment-paypal"
                      name="paymentMethod"
                      checked={paymentMethod === 'paypal'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="h-4 w-4 text-primary"
                    />
                    <label className="ml-2 font-medium text-gray-700" for="payment-paypal">
                      PayPal
                    </label>
                  </div>
                </div>

                <div className="border p-4 rounded-lg">
                  <div className="flex items-start space-x-3">
                    <Percent className="h-5 w-5 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">WiPay</p>
                      <p className="text-sm text-gray-500">
                        Pay via WiPay mobile wallet (coming soon)
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center">
                    <input
                      type="radio"
                      id="payment-wipay"
                      name="paymentMethod"
                      checked={paymentMethod === 'wipay'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="h-4 w-4 text-primary"
                    />
                    <label className="ml-2 font-medium text-gray-700" for="payment-wipay">
                      WiPay
                    </label>
                  </div>
                </div>

                <div className="border p-4 rounded-lg">
                  <div className="flex items-start space-x-3">
                    <DollarSign className="h-5 w-5 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium">Tilopay</p>
                      <p className="text-sm text-gray-500">
                        Pay via Tilopay payment gateway (coming soon)
                      </p>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center">
                    <input
                      type="radio"
                      id="payment-tilopay"
                      name="paymentMethod"
                      checked={paymentMethod === 'tilopay'}
                      onChange={(e) => setPaymentMethod(e.target.value)}
                      className="h-4 w-4 text-primary"
                    />
                    <label className="ml-2 font-medium text-gray-700" for="payment-tilopay">
                      Tilopay
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {/* Order Notes */}
            <div className="border p-4 rounded-lg">
              <h3 className="font-medium mb-3">Order Notes</h3>
              <p className="text-sm text-gray-600">
                Please review your order carefully before submitting. Once submitted,
                changes may not be possible.
              </p>
            </div>

            {/* Submit Button */}
            <div className="mt-8">
              <button
                onClick={handlePlaceOrder}
                disabled={isProcessing || !paymentMethod}
                className="w-full bg-primary text-white px-6 py-3 rounded-lg hover:bg-primary/90
                  transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing Payment...
                  </>
                ) : (
                  <>
                    <CheckCircle className="h-4 w-4" />
                    Place Order
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}