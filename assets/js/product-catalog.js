// Product Catalog JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Product catalog state
    let products = [];
    let filteredProducts = [];
    let currentPage = 1;
    const productsPerPage = 12;

    // DOM elements
    const productsGrid = document.getElementById('productsGrid');
    const categoryFilters = document.getElementById('categoryFilters');
    const priceSlider = document.getElementById('priceSlider');
    const minPriceDisplay = document.getElementById('minPrice');
    const maxPriceDisplay = document.getElementById('maxPrice');
    const inStockOnlyCheckbox = document.getElementById('inStockOnly');
    const sortBySelect = document.getElementById('sortBy');
    const applyFiltersBtn = document.getElementById('applyFilters');
    const clearFiltersBtn = document.getElementById('clearFilters');
    const prevPageBtn = document.getElementById('prevPage');
    const nextPageBtn = document.getElementById('nextPage');
    const pageInfo = document.getElementById('pageInfo');

    // Initialize
    fetchProducts();
    setupEventListeners();

    // Fetch products from JSON
    function fetchProducts() {
        fetch('../assets/data/products.json')
            .then(response => response.json())
            .then(data => {
                products = data;
                filteredProducts = [...products];
                displayProducts();
                setupFilters();
            })
            .catch(error => {
                console.error('Error loading products:', error);
                productsGrid.innerHTML = '<p class="error-message">Error loading products. Please try again later.</p>';
            });
    }

    // Setup event listeners
    function setupEventListeners() {
        priceSlider.addEventListener('input', function() {
            minPriceDisplay.textContent = '$' + this.value;
            maxPriceDisplay.textContent = '$' + priceSlider.max;
        });

        applyFiltersBtn.addEventListener('click', applyFilters);
        clearFiltersBtn.addEventListener('click', clearFilters);
        sortBySelect.addEventListener('change', applyFilters);
        prevPageBtn.addEventListener('click', previousPage);
        nextPageBtn.addEventListener('click', nextPage);
    }

    // Setup filter options based on product data
    function setupFilters() {
        // Get unique categories
        const categories = [...new Set(products.map(p => p.category))];

        // Create category checkboxes
        categories.forEach(category => {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            label.innerHTML = `
                <input type="checkbox" value="${category}"> ${category}
            `;
            categoryFilters.appendChild(label);
        });

        // Add event listeners to category checkboxes
        const categoryCheckboxes = categoryFilters.querySelectorAll('input[type="checkbox"]');
        categoryCheckboxes.forEach(checkbox => {
            checkbox.addEventListener('change', applyFilters);
        });
    }

    // Apply filters and display products
    function applyFilters() {
        // Get filter values
        const selectedCategories = Array.from(categoryFilters.querySelectorAll('input[type="checkbox"]:checked'))
            .map(cb => cb.value);
        const minPrice = 0; // Since slider only has max value
        const maxPrice = parseInt(priceSlider.value);
        const inStockOnly = inStockOnlyCheckbox.checked;
        const sortBy = sortBySelect.value;

        // Filter products
        filteredProducts = products.filter(product => {
            // Category filter
            if (selectedCategories.length > 0 && !selectedCategories.includes(product.category)) {
                return false;
            }

            // Price filter
            if (product.price < minPrice || product.price > maxPrice) {
                return false;
            }

            // Stock filter
            if (inStockOnly && product.stock <= 0) {
                return false;
            }

            return true;
        });

        // Sort products
        filteredProducts.sort((a, b) => {
            switch (sortBy) {
                case 'name-asc':
                    return a.name.localeCompare(b.name);
                case 'name-desc':
                    return b.name.localeCompare(a.name);
                case 'price-low':
                    return a.price - b.price;
                case 'price-high':
                    return b.price - a.price;
                case 'rating-high':
                    return b.rating - a.rating;
                case 'featured':
                default:
                    // Featured first, then by name
                    if (a.isFeatured && !b.isFeatured) return -1;
                    if (!a.isFeatured && b.isFeatured) return 1;
                    return a.name.localeCompare(b.name);
            }
        });

        // Reset to first page
        currentPage = 1;
        displayProducts();
    }

    // Clear all filters
    function clearFilters() {
        // Reset category checkboxes
        const categoryCheckboxes = categoryFilters.querySelectorAll('input[type="checkbox"]');
        categoryCheckboxes.forEach(cb => cb.checked = false);

        // Reset price slider to max
        priceSlider.value = priceSlider.max;
        minPriceDisplay.textContent = '$0';
        maxPriceDisplay.textContent = `$${priceSlider.max}`;

        // Reset stock checkbox
        inStockOnlyCheckbox.checked = false;

        // Reset sort
        sortBySelect.value = 'featured';

        // Reapply filters (which will now show all products)
        applyFilters();
    }

    // Display products for current page
    function displayProducts() {
        // Calculate pagination
        const startIndex = (currentPage - 1) * productsPerPage;
        const endIndex = startIndex + productsPerPage;
        const paginatedProducts = filteredProducts.slice(startIndex, endIndex);

        // Update page info
        const totalPages = Math.max(1, Math.ceil(filteredProducts.length / productsPerPage));
        pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;

        // Enable/disable navigation buttons
        prevPageBtn.disabled = currentPage === 1;
        nextPageBtn.disabled = currentPage === totalPages;

        // Clear grid
        productsGrid.innerHTML = '';

        // If no products found
        if (filteredProducts.length === 0) {
            productsGrid.innerHTML = '<p class="no-products">No products match your filters.</p>';
            return;
        }

        // Create product cards
        paginatedProducts.forEach(product => {
            const productCard = document.createElement('div');
            productCard.className = 'product-card';
            productCard.innerHTML = `
                <div class="product-image">
                    <img src="${product.image}" alt="${product.name}">
                    ${product.isFeatured ? '<span class="badge featured">Featured</span>' : ''}
                    ${product.isNew ? '<span class="badge new">New</span>' : ''}
                </div>
                <div class="product-info">
                    <h3 class="product-title">${product.name}</h3>
                    <p class="product-category">${product.category} > ${product.subcategory}</p>
                    <p class="product-price">$${product.price.toFixed(2)}</p>
                    ${product.originalPrice ? `<p class="original-price">$${product.originalPrice.toFixed(2)}</p>` : ''}
                    <div class="product-rating">
                        ${'★'.repeat(Math.floor(product.rating))}${'☆'.repeat(5 - Math.floor(product.rating))}
                        <span>(${product.reviewCount})</span>
                    </div>
                    <p class="product-stock">${product.stock > 0 ? `In Stock (${product.stock} available)` : 'Out of Stock'}</p>
                    <div class="product-actions">
                        <button class="btn-primary btn-sm view-details" data-id="${product.id}">View Details</button>
                        <button class="btn-secondary btn-sm add-to-cart" data-id="${product.id}">Add to Cart</button>
                    </div>
                </div>
            `;
            productsGrid.appendChild(productCard);
        });

        // Add event listeners to buttons
        document.querySelectorAll('.view-details').forEach(button => {
            button.addEventListener('click', function() {
                const productId = this.getAttribute('data-id');
                window.location.href = `product-detail.html?id=${productId}`;
            });
        });

        document.querySelectorAll('.add-to-cart').forEach(button => {
            button.addEventListener('click', function() {
                const productId = this.getAttribute('data-id');
                addToCart(productId);
            });
        });
    }

    // Add product to cart
    function addToCart(productId) {
        const product = products.find(p => p.id === productId);
        if (!product) return;

        let cart = JSON.parse(localStorage.getItem('cart') || '[]');

        // Check if product already in cart
        const existingItem = cart.find(item => item.id === productId);
        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            cart.push({
                ...product,
                quantity: 1
            });
        }

        localStorage.setItem('cart', JSON.stringify(cart));

        // Show feedback
        showToast(`${product.name} added to cart!`);

        // Update cart count in header if exists
        window.updateCartCount();
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

    // Update cart count in header - using global function from main.js
    // The updateCartCount function is defined globally in main.js

    // Previous page
    function previousPage() {
        if (currentPage > 1) {
            currentPage--;
            displayProducts();
        }
    }

    // Next page
    function nextPage() {
        const totalPages = Math.max(1, Math.ceil(filteredProducts.length / productsPerPage));
        if (currentPage < totalPages) {
            currentPage++;
            displayProducts();
        }
    }

    // Initialize cart count on load
    window.updateCartCount();
});