'use client';

import { useState } from 'react';
import { Link } from 'next/link';
import {
  Heart,
  ShoppingCart,
  Search,
  Plus,
  Minus,
  Trash2,
  ExternalLink,
  Check,
  X
} from 'lucide-react';
import { useCart } from '@/context/cart-context';
import { useWishlist } from '@/context/WishlistContext';
import { Product } from '@/lib/products';

interface ProductCardProps {
  product: Product;
  showActions?: boolean;
  className?: string;
}

export function ProductCard({
  product,
  showActions = true,
  className = ''
}: ProductCardProps) {
  const { addItem, removeItem, cartItems } = useCart();
  const { addToWishlist, removeFromWishlist, isInWishlist } = useWishlist();
  const [quantity, setQuantity] = useState(1);
  const [isHovered, setIsHovered] = useState(false);
  const [isAdded, setIsAdded] = useState(false);
  const [isInWish, setIsInWish] = useState(false);

  const itemInCart = cartItems.find(item => item.id === product.id);
  const itemQuantity = itemInCart ? itemInCart.quantity : 0;

  // Initialize wishlist state
  // In a real app, you'd check against the wishlist context
  // For now, we'll use a simple state - in practice, you'd use useEffect to sync with context

  const handleAddToCart = () => {
    addItem(product);
    setIsAdded(true);
    setTimeout(() => setIsAdded(false), 2000);
  };

  const handleRemoveFromCart = () => {
    removeItem(product.id);
  };

  const handleIncreaseQuantity = () => {
    setQuantity(prev => Math.min(prev + 1, product.stock));
  };

  const handleDecreaseQuantity = () => {
    setQuantity(prev => Math.max(prev - 1, 1));
  };

  const handleAddToWishlist = () => {
    addToWishlist(product);
    setIsInWish(true);
    setTimeout(() => setIsInWish(false), 1500);
  };

  const handleRemoveFromWishlist = () => {
    removeFromWishlist(product.id);
  };

  return (
    <div className={`relative group ${className} hover:shadow-lg transition-shadow duration-300`}>
      {/* Product Image */}
      <div className="aspect-w-16 aspect-h-9 w-full overflow-hidden rounded-lg bg-gray-50">
        <Image
          src={product.image}
          alt={product.name}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          loading="lazy"
        />
        {/* Sale Badge */}
        {product.originalPrice && (
          <div className="absolute top-2 left-2 bg-red-500 text-white text-xs px-2 py-1 rounded">
            Sale
          </div>
        )}
        {/* New Badge */}
        {product.isNew && (
          <div className="absolute top-2 right-2 bg-green-500 text-white text-xs px-2 py-1 rounded">
            New
          </div>
        )}
        {/* Featured Badge */}
        {product.isFeatured && (
          <div className="absolute top-2 right-2 bg-blue-500 text-white text-xs px-2 py-1 rounded">
            Featured
          </div>
        )}
      </div>

      {/* Product Info */}
      <div className="px-4 py-4">
        {/* Category Badge */}
        <div className="mb-2">
          <span className={`text-xs font-medium uppercase px-2 py-0.5 rounded-full
            bg-${product.category.toLowerCase().replace(' ', '-')}-100
            text-${product.category.toLowerCase().replace(' ', '-')}-800`}>
            {product.subcategory}
          </span>
        </div>

        {/* Product Name */}
        <h3 className="text-lg font-semibold text-gray-900 line-clamp-2 mb-2">
          <Link href={`/product/${product.slug}`} className="hover:underline">
            {product.name}
          </Link>
        </h3>

        {/* Product Rating */}
        <div className="flex items-center mb-2">
          {[1, 2, 3, 4, 5].map(star => (
            <span key={star} className="text-yellow-400">
              {star <= Math.floor(product.rating) ? '★' :
               star === Math.round(product.rating * 2) / 2 ? '✩' : '☆'}
            </span>
          ))}
          <span className="ml-1 text-xs text-gray-500">
            ({product.reviewCount})
          </span>
        </div>

        {/* Product Price */}
        <div className="flex items-center mb-4">
          <span className="text-xl font-bold text-gray-900">
            ${product.price.toFixed(2)}
          </span>
          {product.originalPrice && (
            <span className="ml-2 text-sm line-through text-gray-500">
              ${product.originalPrice.toFixed(2)}
            </span>
          )}
        </div>

        {/* Action Buttons */}
        {showActions && (
          <div className="space-y-2">
            {/* Quantity Selector */}
            <div className="flex items-center justify-between bg-gray-50 p-3 rounded-lg">
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleDecreaseQuantity}
                  disabled={quantity <= 1}
                  className="p-1 rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
                  aria-label="Decrease quantity"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="w-8 text-center">{quantity}</span>
                <button
                  onClick={handleIncreaseQuantity}
                  disabled={quantity >= product.stock}
                  className="p-1 rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
                  aria-label="Increase quantity"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>

              {/* Add to Cart Button */}
              <button
                onClick={handleAddToCart}
                className={`flex-1 bg-primary text-white px-4 py-2 rounded hover:bg-primary/90
                  transition-colors disabled:opacity-50 ${isAdded ? 'bg-success' : ''}`}
                disabled={quantity <= 0}
              >
                {isAdded ? (
                  <>
                    <Check className="mr-2 h-4 w-4" />
                    Added
                  </>
                ) : (
                  <>
                    <ShoppingCart className="mr-2 h-4 w-4" />
                    Add to Cart
                  </>
                )}
              </button>
            </div>

            {/* Action Icons */}
            <div className="flex justify-between items-center">
              <button
                onClick={handleAddToWishlist}
                className={`p-2 rounded hover:bg-gray-200 transition-colors ${isInWish ? 'text-red-500' : ''}`}
                aria-label="Add to wishlist"
              >
                {isInWish ? (
                  <Heart className="h-4 w-4" />
                ) : (
                  <Heart className="h-4 w-4 text-gray-500" />
                )}
              </button>

              <Link
                href={`/product/${product.slug}`}
                className="p-2 rounded hover:bg-gray-200 transition-colors"
                aria-label="View product details"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}