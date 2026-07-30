// Quote Request Form Script
document.addEventListener('DOMContentLoaded', function() {
    const quoteForm = document.getElementById('quoteForm');
    const quoteThankYou = document.getElementById('quoteThankYou');
    const quoteProductSelect = document.getElementById('quoteProduct');

    // Populate product dropdown
    fetch('../assets/data/products.json')
        .then(response => response.json())
        .then(products => {
            // Add a default option
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Select a product (optional)';
            quoteProductSelect.appendChild(defaultOption);

            // Add products grouped by category
            const categories = {};
            products.forEach(product => {
                if (!categories[product.category]) {
                    categories[product.category] = [];
                }
                categories[product.category].push(product);
            });

            // Add optgroups for each category
            Object.keys(categories).forEach(category => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = category;

                categories[category].forEach(product => {
                    const option = document.createElement('option');
                    option.value = product.name;
                    option.textContent = product.name;
                    optgroup.appendChild(option);
                });

                quoteProductSelect.appendChild(optgroup);
            });
        })
        .catch(error => {
            console.error('Error loading products:', error);
        });

    // Form submission
    quoteForm.addEventListener('submit', function(e) {
        e.preventDefault();

        // Basic validation
        const name = document.getElementById('quoteName').value.trim();
        const phone = document.getElementById('quotePhone').value.trim();
        const email = document.getElementById('quoteEmail').value.trim();
        const service = document.getElementById('quoteService').value;
        const product = document.getElementById('quoteProduct').value;
        const message = document.getElementById('quoteMessage').value.trim();
        const date = document.getElementById('quoteDate').value;

        if (!name || !phone || !email || !service || !message) {
            alert('Please fill in all required fields.');
            return;
        }

        // Show loading state
        const submitButton = quoteForm.querySelector('button[type="submit"]');
        const originalText = submitButton.innerHTML;
        submitButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
        submitButton.disabled = true;

        // Submit the quote request to the admin backend inbox.
        const details = [
            'Service required: ' + service,
            product ? 'Product of interest: ' + product : '',
            date ? 'Preferred date: ' + date : '',
            '',
            message,
        ].filter(Boolean).join('\n');

        window.CoolAirSubmitQuote({ name: name, email: email, phone: phone, message: details })
            .then(function () {
                quoteForm.style.display = 'none';
                quoteThankYou.style.display = 'block';
                quoteForm.reset();
            })
            .catch(function (err) {
                alert(err.message || 'We could not submit your request right now. Please call us instead.');
            })
            .finally(function () {
                submitButton.innerHTML = originalText;
                submitButton.disabled = false;
            });
    });
});
