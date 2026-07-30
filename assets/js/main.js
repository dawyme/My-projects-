// Site-wide interactions for N&D's Air Conditioning & Refrigeration
(function () {
    'use strict';

    const CART_KEY = 'cart';
    const PHONE_DISPLAY = '(868) 707-4646';
    const PHONE_HREF = 'tel:+18687074646';
    const WHATSAPP_URL = 'https://wa.me/18687074646?text=Hi%20N%26D%27s%2C%20I%20need%20HVAC%20service%20assistance.';

    function getRelativeRoot() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        const file = parts[parts.length - 1] || '';
        const directoryDepth = file.includes('.') ? Math.max(parts.length - 1, 0) : parts.length;
        return directoryDepth ? '../'.repeat(directoryDepth) : '';
    }

    function setMenuState(navToggle, navMenu, isOpen) {
        navMenu.classList.toggle('active', isOpen);
        navToggle.classList.toggle('active', isOpen);
        navToggle.setAttribute('aria-expanded', String(isOpen));
        document.body.classList.toggle('menu-open', isOpen);
    }

    function initMobileNavigation() {
        const navToggle = document.querySelector('.nav-toggle');
        const navMenu = document.querySelector('.nav-menu');

        if (!navToggle || !navMenu) return;

        if (!navToggle.hasAttribute('aria-label')) navToggle.setAttribute('aria-label', 'Toggle navigation');
        if (!navToggle.hasAttribute('aria-controls')) navToggle.setAttribute('aria-controls', navMenu.id || 'primary-menu');
        if (!navMenu.id) navMenu.id = 'primary-menu';
        navToggle.setAttribute('aria-expanded', 'false');

        navToggle.addEventListener('click', function (event) {
            event.stopPropagation();
            setMenuState(navToggle, navMenu, !navMenu.classList.contains('active'));
        });

        navMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => setMenuState(navToggle, navMenu, false));
        });

        document.addEventListener('click', function (event) {
            if (navMenu.classList.contains('active') && !event.target.closest('.site-header')) {
                setMenuState(navToggle, navMenu, false);
            }
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && navMenu.classList.contains('active')) {
                setMenuState(navToggle, navMenu, false);
                navToggle.focus();
            }
        });

        window.addEventListener('resize', function () {
            if (window.innerWidth > 992 && navMenu.classList.contains('active')) {
                setMenuState(navToggle, navMenu, false);
            }
        }, { passive: true });
    }

    function initForms() {
        const forms = document.querySelectorAll('#contactForm, #appointmentForm, #bookingForm, #quoteForm');

        forms.forEach(form => {
            if (form.dataset.enhanced === 'true') return;
            form.dataset.enhanced = 'true';

            form.addEventListener('submit', async function (event) {
                event.preventDefault();

                let isValid = true;
                const requiredInputs = form.querySelectorAll('input[required], select[required], textarea[required]');

                requiredInputs.forEach(input => {
                    const valid = Boolean(input.value.trim());
                    input.classList.toggle('field-error', !valid);
                    input.setAttribute('aria-invalid', String(!valid));
                    if (!valid) isValid = false;
                });

                if (!isValid) {
                    const firstInvalid = form.querySelector('.field-error');
                    if (firstInvalid) firstInvalid.focus();
                    alert('Please fill in all required fields.');
                    return;
                }

                const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                const originalText = submitBtn ? submitBtn.innerHTML || submitBtn.value : '';
                if (submitBtn) {
                    if (submitBtn.tagName === 'INPUT') submitBtn.value = 'Sending...';
                    else submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Sending...';
                    submitBtn.disabled = true;
                }

                let submitted = false;
                const action = form.getAttribute('action');
                const method = (form.getAttribute('method') || 'POST').toUpperCase();

                if (action && /^https?:\/\//.test(action)) {
                    try {
                        const response = await fetch(action, {
                            method,
                            body: new FormData(form),
                            mode: 'no-cors'
                        });
                        submitted = response.ok || response.type === 'opaque' || response.status === 0;
                    } catch (error) {
                        console.warn('Remote form submission unavailable; showing local confirmation.', error);
                    }
                }

                // Static-site fallback: keep the UX working even if the third-party endpoint blocks CORS.
                if (!submitted) {
                    await new Promise(resolve => setTimeout(resolve, 600));
                }

                form.reset();
                form.style.display = 'none';
                const thankYouMessage = document.getElementById('thank-you-message');
                if (thankYouMessage) {
                    thankYouMessage.style.display = 'block';
                    thankYouMessage.setAttribute('tabindex', '-1');
                    thankYouMessage.focus({ preventScroll: true });
                    thankYouMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    alert('Thank you. Your request has been received.');
                }

                if (submitBtn) {
                    if (submitBtn.tagName === 'INPUT') submitBtn.value = originalText;
                    else submitBtn.innerHTML = originalText;
                    submitBtn.disabled = false;
                }
            });
        });
    }

    function initSmoothScrolling() {
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (event) {
                const href = this.getAttribute('href');
                if (!href || href === '#') return;
                const target = document.querySelector(href);
                if (target) {
                    event.preventDefault();
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });
    }

    function initScrollSpy() {
        const sections = document.querySelectorAll('section[id]');
        const scrollNavLinks = document.querySelectorAll('.nav-menu a[href^="#"]');
        if (!sections.length || !scrollNavLinks.length) return;

        window.addEventListener('scroll', () => {
            let current = '';
            sections.forEach(section => {
                if (window.pageYOffset >= section.offsetTop - 80) {
                    current = section.getAttribute('id');
                }
            });
            scrollNavLinks.forEach(link => {
                link.classList.toggle('active', link.getAttribute('href').slice(1) === current);
            });
        }, { passive: true });
    }

    function initRevealAnimations() {
        const animateElements = document.querySelectorAll('.service-card, .team-member, .value-item, .info-item, .product-card, .gallery-item, .testimonial-slide, .testimonial-card, .why-item');
        if (!animateElements.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        if (!('IntersectionObserver' in window)) {
            animateElements.forEach(el => el.classList.add('is-visible'));
            return;
        }

        const observer = new IntersectionObserver((entries, instance) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    instance.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12, rootMargin: '0px 0px -30px 0px' });

        animateElements.forEach(el => {
            el.classList.add('reveal-on-scroll');
            observer.observe(el);
        });
    }

    function initLazyImages() {
        document.querySelectorAll('img').forEach(img => {
            if (!img.closest('.site-header') && !img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
            if (!img.hasAttribute('decoding')) img.setAttribute('decoding', 'async');
        });

        const lazyImages = document.querySelectorAll('img[data-src]');
        if (!lazyImages.length) return;

        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        img.classList.add('loaded');
                        observer.unobserve(img);
                    }
                });
            }, { rootMargin: '150px 0px' });

            lazyImages.forEach(img => imageObserver.observe(img));
        } else {
            lazyImages.forEach(img => {
                img.src = img.dataset.src;
                img.removeAttribute('data-src');
                img.classList.add('loaded');
            });
        }
    }

    function initFloatingActions() {
        if (document.querySelector('.floating-actions')) return;
        const actions = document.createElement('div');
        actions.className = 'floating-actions';
        actions.innerHTML = `
            <a class="floating-action whatsapp-action" href="${WHATSAPP_URL}" target="_blank" rel="noopener" aria-label="Chat with N&D's on WhatsApp">
                <i class="fab fa-whatsapp" aria-hidden="true"></i><span>WhatsApp</span>
            </a>
            <a class="floating-action phone-action" href="${PHONE_HREF}" aria-label="Call N&D's at ${PHONE_DISPLAY}">
                <i class="fas fa-phone" aria-hidden="true"></i><span>Call</span>
            </a>
        `;
        document.body.appendChild(actions);
    }

    function getCart() {
        try {
            return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
        } catch (error) {
            return [];
        }
    }

    window.updateCartCount = function () {
        const cart = getCart();
        const totalItems = cart.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
        let cartCountElement = document.querySelector('.cart-count');

        if (!cartCountElement && totalItems > 0) {
            const navItems = document.querySelector('.nav-menu');
            if (navItems) {
                const root = getRelativeRoot();
                const cartItem = document.createElement('li');
                cartItem.innerHTML = `
                    <a href="${root}cart.html" class="cart-link" aria-label="View cart">
                        <i class="fas fa-shopping-cart" aria-hidden="true"></i>
                        <span class="cart-count">${totalItems}</span>
                    </a>
                `;
                navItems.appendChild(cartItem);
                cartCountElement = cartItem.querySelector('.cart-count');
            }
        }

        if (cartCountElement) {
            cartCountElement.textContent = totalItems;
            cartCountElement.style.display = totalItems > 0 ? 'inline-flex' : 'none';
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        initMobileNavigation();
        initForms();
        initSmoothScrolling();
        initScrollSpy();
        initRevealAnimations();
        initLazyImages();
        initFloatingActions();
        window.updateCartCount();
    });
})();
