// Testimonials Slider Script
document.addEventListener('DOMContentLoaded', function() {
    const slides = document.querySelectorAll('.testimonial-slide');
    const prevBtn = document.getElementById('prevTestimonial');
    const nextBtn = document.getElementById('nextTestimonial');
    const counter = document.getElementById('testimonialCounter');

    if (slides.length === 0) return;

    let currentIndex = 0;

    // Show current slide
    function showSlide(index) {
        // Hide all slides
        slides.forEach(slide => {
            slide.style.display = 'none';
        });

        // Show selected slide
        slides[index].style.display = 'block';

        // Update counter
        counter.textContent = `${index + 1} / ${slides.length}`;
    }

    // Previous slide
    prevBtn.addEventListener('click', function() {
        currentIndex = (currentIndex - 1 + slides.length) % slides.length;
        showSlide(currentIndex);
    });

    // Next slide
    nextBtn.addEventListener('click', function() {
        currentIndex = (currentIndex + 1) % slides.length;
        showSlide(currentIndex);
    });

    // Initialize
    showSlide(currentIndex);

    // Auto-advance every 5 seconds
    setInterval(() => {
        currentIndex = (currentIndex + 1) % slides.length;
        showSlide(currentIndex);
    }, 5000);
});