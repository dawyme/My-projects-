# N&D's Air Conditioning and Refrigeration Website

A responsive website for N&D's Air Conditioning and Refrigeration services with online appointment booking functionality.

## Features

- Responsive design that works on mobile, tablet, and desktop devices
- Modern, clean UI with intuitive navigation
- Service pages showcasing AC repair, installation, maintenance, and refrigeration services
- About us page with company history, mission, values, and team information
- Contact page with appointment scheduling form
- 24/7 emergency service highlighting
- Interactive elements with smooth animations
- SEO-friendly structure

## Pages

1. **Home** (`index.html`) - Landing page with hero section, service overview, and call-to-action
2. **Services** (`services.html`) - Detailed information about all services offered
3. **About Us** (`about.html`) - Company history, mission, values, team, and service areas
4. **Contact** (`contact.html`) - Contact information and appointment booking form

## Technologies Used

- HTML5
- CSS3 (with Flexbox and Grid)
- Vanilla JavaScript
- Google Fonts (Montserrat and Open Sans)
- Font Awesome Icons (for icons - would need to be added in production)
- Formspree (for form handling - replace with actual form endpoint)

## File Structure

```
/root
  ├── index.html              # Home page
  ├── services.html           # Services page
  ├── about.html              # About us page
  ├── contact.html            # Contact page with appointment form
  │
  ├── /assets
  │   ├── /css
  │   │   └── style.css       # Main stylesheet
  │   │
  │   ├── /js
  │   │   └── main.js         # JavaScript for interactivity
  │   │
  │   └── /images             # Image directory (place images here)
  │
  └── README.md               # This file
```

## Customization

### Colors
The primary color scheme uses:
- Primary Blue: `#3498db` (buttons, links, accents)
- Dark Blue: `#2c3e50` (text, headers)
- Light Gray: `#ecf0f1` (backgrounds, cards)
- White: `#ffffff` (main background)
- Orange Accent: `#fab1a0` (CTA sections)
- Red: `#e74c3c` (emergency buttons, errors)

To change colors, edit the CSS variables in `assets/css/style.css`.

### Images
Replace the placeholder images in the HTML with actual images by:
1. Adding your images to the `/assets/images/` directory
2. Updating the `src` attribute of `<img>` tags or the `background-image` CSS property

### Form Integration
The contact form is set up to work with Formspree. To use it:
1. Sign up for a free account at [Formspree.io](https://formspree.io/)
2. Create a new form to get your endpoint URL
3. Replace the `action` attribute in the form tag in `contact.html` with your Formspree endpoint
4. Optional: Configure redirect URL or email notifications in Formspree

### Content Updates
All text content can be easily updated by editing the HTML files:
- Update service descriptions in `services.html`
- Modify company information in `about.html`
- Change contact details in `contact.html`

## Responsive Breakpoints

The design uses responsive breakpoints:
- **Desktop**: 992px and above
- **Tablet**: 768px - 991px
- **Mobile**: Below 768px

## Browser Support

This website is designed to work in all modern browsers:
- Chrome (latest)
- Firefox (latest)
- Safari (latest)
- Edge (latest)

## Deployment

To deploy this website:

1. **GitHub Pages**:
   - Push the repository to GitHub
   - Go to repository Settings > Pages
   - Select the main branch and save
   - Your site will be published at `https://username.github.io/repository-name`

2. **Netlify**:
   - Drag and drop the project folder to Netlify drop zone
   - Or connect your GitHub repository for continuous deployment

3. **Vercel**:
   - Import your GitHub repository
   - Vercel will automatically detect and deploy the site

4. **Traditional Hosting**:
   - Upload all files to your web server's public directory
   - Ensure the directory structure is maintained

## Maintenance

- Regularly update content to keep information current
- Monitor form submissions and respond promptly to inquiries
- Check for broken links periodically
- Update images and testimonials as needed
- Keep an eye on website performance using tools like Google PageSpeed Insights

## Credits

- Design and development by Claude Code
- Icons would be provided by Font Awesome (https://fontawesome.com/)
- Fonts provided by Google Fonts (https://fonts.google.com/)

## License

This project is for educational and demonstration purposes. For commercial use, please ensure you have the appropriate licenses for any third-party assets used.