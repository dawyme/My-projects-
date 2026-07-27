// Checkout Script
document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const orderSummary = document.getElementById('orderSummary');
    const checkoutForm = document.getElementById('checkoutForm');

    // Load order summary
    loadOrderSummary();

    // Form submission
    checkoutForm.addEventListener('submit', function(e) {
        e.preventDefault();

        // Basic validation
        if (!validateForm()) {
            return;
        }

        // Get selected payment method
        const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked').value;

        // If WhatsApp is selected, handle via WhatsApp
        if (paymentMethod === 'whatsapp') {
            handleWhatsAppOrder();
            return;
        }

        // For other payment methods, proceed with standard processing
        processOrder();
    });

    // Load order summary from cart
    function loadOrderSummary() {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');

        if (cart.length === 0) {
            orderSummary.innerHTML = '<p>Your cart is empty.</p>';
            return;
        }

        // Calculate totals
        const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const tax = subtotal * 0.15; // 15% tax
        const total = subtotal + tax;

        // Create order summary HTML
        let html = '<h3>Items:</h3>';
        cart.forEach(item => {
            html += `
                <div class="order-item">
                    <img src="${item.image}" alt="${item.name}" onerror="this.onerror=null;this.src='../assets/images/placeholder-product.jpg';" class="order-item-image">
                    <div class="order-item-details">
                        <h4>${item.name}</h4>
                        <p>Quantity: ${item.quantity} x $${item.price.toFixed(2)}</p>
                        <p class="item-total">Subtotal: $${(item.price * item.quantity).toFixed(2)}</p>
                    </div>
                </div>
            `;
        });

        html += `
            <div class="order-summary-totals">
                <div class="totals-row">
                    <span>Subtotal:</span>
                    <span>$${subtotal.toFixed(2)}</span>
                </div>
                <div class="totals-row">
                    <span>Tax (15%):</span>
                    <span>$${tax.toFixed(2)}</span>
                </div>
                <div class="totals-row total">
                    <span>Total:</span>
                    <span>$${total.toFixed(2)}</span>
                </div>
            </div>
        `;

        orderSummary.innerHTML = html;
    }

    // Form validation
    function validateForm() {
        const inputs = checkoutForm.querySelectorAll('input[required]');
        let isValid = true;

        inputs.forEach(input => {
            if (!input.value.trim()) {
                isValid = false;
                input.style.borderColor = '#e74c3c';
            } else {
                input.style.borderColor = '#ddd';
            }
        });

        if (!isValid) {
            alert('Please fill in all required fields.');
        }

        return isValid;
    }

    // Handle WhatsApp order
    function handleWhatsAppOrder() {
        // Get form values
        const fullName = document.getElementById('fullName').value.trim();
        const email = document.getElementById('email').value.trim();
        const phone = document.getElementById('phone').value.trim();
        const address = document.getElementById('address').value.trim();
        const city = document.getElementById('city').value.trim();
        const state = document.getElementById('state').value.trim();
        const zipCode = document.getElementById('zipCode').value.trim();
        const country = document.getElementById('country').value.trim();

        // Get cart items
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');
        if (cart.length === 0) {
            alert('Your cart is empty.');
            return;
        }

        // Calculate totals
        let subtotal = 0;
        cart.forEach(item => {
            subtotal += item.price * item.quantity;
        });
        const tax = subtotal * 0.15; // 15% tax
        const total = subtotal + tax;

        // Build message
        let message = `Hello, I'd like to place an order for the following items:\n\n`;
        cart.forEach(item => {
            message += `- ${item.name} (Quantity: ${item.quantity}) - $${(item.price * item.quantity).toFixed(2)}\n`;
        });
        message += `\n*Subtotal:* $${subtotal.toFixed(2)}\n`;
        message += `*Tax (15%):* $${tax.toFixed(2)}\n`;
        message += `*Total:* $${total.toFixed(2)}\n\n`;
        message += `*Customer Details:*\n`;
        message += `Name: ${fullName}\n`;
        message += `Phone: ${phone}\n`;
        message += `Email: ${email}\n`;
        message += `Address: ${address}, ${city}, ${state}, ${zipCode}, ${country}\n\n`;
        message += `Please confirm the order and provide payment instructions.`;

        // Encode message for URL
        const encodedMessage = encodeURIComponent(message);

        // WhatsApp business number (Trinidad and Tobago)
        const whatsappNumber = '18687074646'; // Remove + and any punctuation
        const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodedMessage}`;

        // Open WhatsApp in a new tab
        window.open(whatsappUrl, '_blank');

        // Clear cart after sending order
        localStorage.removeItem('cart');

        // Optionally, show a confirmation message
        alert('Your order has been sent via WhatsApp. Please check your phone for a response from our team.');
    }

    // Process order (simulation)
    function processOrder() {
        // Show loading state on button
        const submitButton = checkoutForm.querySelector('button[type="submit"]');
        const originalText = submitButton.innerHTML;
        submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        submitButton.disabled = true;

        // Simulate processing delay
        setTimeout(() => {
            // Clear cart
            localStorage.removeItem('cart');

            // Show thank you message
            orderSummary.innerHTML = `
                <div class="order-success">
                    <h3>Thank You for Your Order!</h3>
                    <p>Your order has been successfully placed. We will contact you shortly to confirm delivery details.</p>
                    <p><strong>Order Number:</strong> ND${Date.now().toString().slice(-6)}</p>
                    <a href="../index.html" class="btn-primary">Continue Shopping</a>
                </div>
            `;

            // Reset button
            submitButton.innerHTML = originalText;
            submitButton.disabled = false;
        }, 2000);
    }
});