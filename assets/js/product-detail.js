// Product Detail Page Script
document.addEventListener('DOMContentLoaded', function() {
    // Get product ID from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const productId = urlParams.get('id');

    if (!productId) {
        window.location.href = '../products/index.html';
        return;
    }

    // Fetch product data
    fetch('../assets/data/products.json')
        .then(response => response.json())
        .then(products => {
            const product = products.find(p => p.id === productId);

            if (!product) {
                // Product not found
                document.querySelector('.product-detail-content').innerHTML = '<p>Product not found.</p>';
                return;
            }

            // Populate product details
            document.getElementById('productTitle').textContent = product.name;
            document.getElementById('productCategory').textContent = product.category;
            document.getElementById('productSku').textContent = product.id;

            // Stock status
            const stockElement = document.getElementById('productStock');
            if (product.stock > 0) {
                stockElement.textContent = `In Stock (${product.stock} available)`;
                stockElement.style.color = '#27ae60';
            } else {
                stockElement.textContent = 'Out of Stock';
                stockElement.style.color = '#e74c3c';
            }

            // Rating
            const ratingStars = document.getElementById('productRatingStars');
            for (let i = 1; i <= 5; i++) {
                const star = document.createElement('span');
                star.className = 'star';
                star.innerHTML = i <= Math.floor(product.rating) ? '★' : '☆';
                if (i === Math.ceil(product.rating) && !Number.isInteger(product.rating)) {
                    star.innerHTML = '⯪'; // Half star
                }
                ratingStars.appendChild(star);
            }
            document.getElementById('productReviewCount').textContent = `(${product.reviewCount} reviews)`;

            // Price
            document.getElementById('productPrice').textContent = `$${product.price.toFixed(2)}`;
            if (product.originalPrice) {
                document.getElementById('productOriginalPrice').textContent = `$${product.originalPrice.toFixed(2)}`;
                document.getElementById('productOriginalPrice').style.display = 'inline-block';
            } else {
                document.getElementById('productOriginalPrice').style.display = 'none';
            }

            // Description
            document.getElementById('productDescription').textContent = product.description;

            // Features
            const featuresList = document.getElementById('productFeaturesList');
            product.features.forEach(feature => {
                const li = document.createElement('li');
                li.textContent = feature;
                featuresList.appendChild(li);
            });

            // Specifications
            const specsTable = document.getElementById('productSpecificationsTable');
            for (const [key, value] of Object.entries(product.specs)) {
                const row = document.createElement('tr');

                const nameCell = document.createElement('td');
                nameCell.textContent = key;
                nameCell.style.fontWeight = '600';

                const valueCell = document.createElement('td');
                valueCell.textContent = value;

                row.appendChild(nameCell);
                row.appendChild(valueCell);
                specsTable.appendChild(row);
            }

            // Main image
            document.getElementById('mainProductImage').src = product.image;
            document.getElementById('mainProductImage').alt = product.name;

            // Thumbnails (if we had multiple images, for now just show the main one)
            // In a real implementation, you might have an array of images

            // Related products (same category, excluding current product)
            const relatedProducts = products
                .filter(p => p.category === product.category && p.id !== product.id)
                .slice(0, 4); // Show 4 related products

            const relatedGrid = document.getElementById('relatedProductsGrid');
            if (relatedProducts.length > 0) {
                relatedProducts.forEach(related => {
                    const card = document.createElement('div');
                    card.className = 'related-product-card';
                    card.innerHTML = `
                        <img src="${related.image}" alt="${related.name}" onerror="this.onerror=null;this.src='../assets/images/placeholder-product.jpg';">
                        <h3>${related.name}</h3>
                        <p class="price">$${related.price.toFixed(2)}</p>
                        <a href="product-detail.html?id=${related.id}" class="btn-secondary">View Details</a>
                    `;
                    relatedGrid.appendChild(card);
                });
            } else {
                document.getElementById('relatedProductsGrid').innerHTML = '<p>No related products found.</p>';
            }

            // Add to cart functionality
            const addToCartBtn = document.getElementById('addToCartBtn');
            const viewCartBtn = document.getElementById('viewCartBtn');
            const quantityInput = document.getElementById('productQuantity');

            addToCartBtn.addEventListener('click', function() {
                if (product.stock <= 0) {
                    alert('This product is currently out of stock.');
                    return;
                }

                const quantity = parseInt(quantityInput.value);
                if (quantity > product.stock) {
                    alert(`Only ${product.stock} items available in stock.`);
                    return;
                }

                // Get existing cart from localStorage
                let cart = JSON.parse(localStorage.getItem('cart') || '[]');

                // Check if product already in cart
                const existingItemIndex = cart.findIndex(item => item.id === product.id);

                if (existingItemIndex >= 0) {
                    // Update quantity
                    cart[existingItemIndex].quantity += quantity;
                    // Don't exceed stock
                    if (cart[existingItemIndex].quantity > product.stock) {
                        cart[existingItemIndex].quantity = product.stock;
                    }
                } else {
                    // Add new item
                    cart.push({
                        id: product.id,
                        name: product.name,
                        price: product.price,
                        image: product.image,
                        quantity: quantity
                    });
                }

                // Save cart back to localStorage
                localStorage.setItem('cart', JSON.stringify(cart));

                // Show feedback
                showToast(`${product.name} added to cart!`);

                // Update cart count
                updateCartCount();
            });

            viewCartBtn.addEventListener('click', function() {
                window.location.href = '../cart.html';
            });
        })
        .catch(error => {
            console.error('Error loading product data:', error);
            document.querySelector('.product-detail-content').innerHTML = '<p>Error loading product details.</p>';
        });

    // Update cart count in header
    function updateCartCount() {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');
        const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);

        let cartCountElement = document.querySelector('.cart-count');
        if (!cartCountElement) {
            // Create cart count element if it doesn't exist
            const navItems = document.querySelector('.nav-menu');
            if (navItems) {
                const cartLink = document.createElement('li');
                cartLink.innerHTML = `
                    <a href="../cart.html" class="cart-link">
                        <i class="fas fa-shopping-cart"></i>
                        <span class="cart-count">${totalItems}</span>
                    </a>
                `;
                navItems.appendChild(cartLink);
                cartCountElement = cartLink.querySelector('.cart-count');
            }
        }

        if (cartCountElement) {
            cartCountElement.textContent = totalItems;
            cartCountElement.style.display = totalItems > 0 ? 'block' : 'none';
        }
    }

    // Show toast notification
    function showToast(message) {
        // Remove any existing toast
        const existingToast = document.querySelector('.toast');
        if (existingToast) {
            existingToast.remove();
        }

        // Create toast
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;

        // Add styles
        toast.style.position = 'fixed';
        toast.style.bottom = '20px';
        toast.style.right = '20px';
        toast.style.backgroundColor = '#2c3e50';
        toast.style.color = 'white';
        toast.style.padding = '12px 24px';
        toast.style.borderRadius = '4px';
        toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        toast.style.zIndex = '1000';
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';

        document.body.appendChild(toast);

        // Trigger reflow to enable transition
        void toast.offsetWidth;

        // Show toast
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';

        // Hide after 3 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(20px)';
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 3000);
    }

    // Initialize cart count on load
    updateCartCount();
});