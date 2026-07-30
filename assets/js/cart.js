// Shopping Cart Script
document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const cartItemsContainer = document.getElementById('cartItems');
    const subtotalElement = document.getElementById('subtotal');
    const taxElement = document.getElementById('tax');
    const totalElement = document.getElementById('total');
    const checkoutBtn = document.getElementById('checkoutBtn');

    // Tax rate (example: 15%)
    const TAX_RATE = 0.15;

    // Load cart and display
    loadCart();

    // Event listeners
    checkoutBtn.addEventListener('click', proceedToCheckout);

    // Load cart from localStorage and render
    function loadCart() {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');

        if (cart.length === 0) {
            cartItemsContainer.innerHTML = '<p class="empty-cart">Your cart is empty.</p>';
            updateCartSummary(0, 0, 0);
            return;
        }

        // Clear container
        cartItemsContainer.innerHTML = '';

        // Add each item
        cart.forEach((item, index) => {
            const cartItem = document.createElement('div');
            cartItem.className = 'cart-item';
            cartItem.innerHTML = `
                <img src="${item.image}" alt="${item.name}" onerror="this.onerror=null;this.src='../assets/images/placeholder-product.svg';">
                <div class="cart-item-details">
                    <h3>${item.name}</h3>
                    <p class="item-price">$${item.price.toFixed(2)}</p>
                    <div class="item-quantity">
                        <label>Quantity:</label>
                        <input type="number" min="1" value="${item.quantity}" data-index="${index}">
                    </div>
                    <p class="item-total">Total: $${(item.price * item.quantity).toFixed(2)}</p>
                </div>
                <button class="remove-item" data-index="${index}">&times;</button>
            `;
            cartItemsContainer.appendChild(cartItem);
        });

        // Add event listeners to quantity inputs and remove buttons
        document.querySelectorAll('.item-quantity input').forEach(input => {
            input.addEventListener('change', function() {
                const index = parseInt(this.getAttribute('data-index'));
                const quantity = parseInt(this.value);
                updateCartItemQuantity(index, quantity);
            });
        });

        document.querySelectorAll('.remove-item').forEach(button => {
            button.addEventListener('click', function() {
                const index = parseInt(this.getAttribute('data-index'));
                removeCartItem(index);
            });
        });

        // Update summary
        updateCartSummary(cart);
    }

    // Update cart item quantity
    function updateCartItemQuantity(index, quantity) {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');
        if (cart[index]) {
            if (quantity < 1) {
                // Remove item if quantity is less than 1
                removeCartItem(index);
                return;
            }

            cart[index].quantity = quantity;
            localStorage.setItem('cart', JSON.stringify(cart));
            window.updateCartCount();
            loadCart(); // Reload to update totals
        }
    }

    // Remove cart item
    function removeCartItem(index) {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');
        cart.splice(index, 1);
        localStorage.setItem('cart', JSON.stringify(cart));
        window.updateCartCount();
        loadCart(); // Reload to update display
    }

    // Update cart summary
    function updateCartSummary(cart) {
        if (!cart || cart.length === 0) {
            subtotalElement.textContent = '$0.00';
            taxElement.textContent = '$0.00';
            totalElement.textContent = '$0.00';
            return;
        }

        const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const tax = subtotal * TAX_RATE;
        const total = subtotal + tax;

        subtotalElement.textContent = `$${subtotal.toFixed(2)}`;
        taxElement.textContent = `$${tax.toFixed(2)}`;
        totalElement.textContent = `$${total.toFixed(2)}`;
    }

    // Proceed to checkout
    function proceedToCheckout() {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');
        if (cart.length === 0) {
            alert('Your cart is empty. Please add items before checking out.');
            return;
        }
        window.location.href = 'checkout.html';
    }
});