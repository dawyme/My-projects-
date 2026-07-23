'use client';

import { useState } from 'react';
import { ProductCard } from '@/components/products/ProductCard';
import { useWishlist } from '@/context/WishlistContext';

export default function WishlistPage() {
  const { wishlistItems, removeFromWishlist, isInWishlist } = useWishlist();
  const [view, setView] = useState('grid'); // grid or list

  if (wishlistItems.length === 0) {
    return (
      <div className="min-h-[calc(100vh-160px)] py-12">
        <div className="max-w-xl mx-auto px-4 text-center">
          <div className="mb-8">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border-2 border-dashed border-gray-300">
              <Heart className="h-6 w-6 text-gray-400" />
            </span>
          </div>
          <h2 className="text-2xl font-bold mb-4">Your wishlist is empty</h2>
          <p className="text-gray-600 mb-6">
            You haven't saved any products to your wishlist yet.
          </p>
          <div className="flex justify-center">
            <a
              href="/products"
              className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
            >
              <ArrowRight className="mr-2 h-4 w-4" />
              Browse Products
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            Wishlist
          </h1>
          <p className="text-gray-600">
            {wishlistItems.length} item{wishlistItems.length !== 1 ? 's' : ''} saved for later
          </p>
        </div>

        {/* View Options */}
        <div className="mb-6 flex justify-between items-center">
          <div className="flex items-center space-x-3">
            <p className="text-sm text-gray-500">View as:</p>
            <button
              onClick={() => setView('grid')}
              className={`p-2 rounded hover:bg-gray-200 ${view === 'grid' ? 'bg-primary/10 text-primary' : ''}`}
              aria-label="Grid view"
            >
              <Grid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setView('list')}
              className={`ml-2 p-2 rounded hover:bg-gray-200 ${view === 'list' ? 'bg-primary/10 text-primary' : ''}`}
              aria-label="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>

          {/* Actions */}
          <div className="flex items-center space-x-3">
            <button
              onClick={() => {
                // Move all to cart (placeholder)
                alert('Moving all items to cart!');
              }}
              className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors"
            >
              <ShoppingCart className="mr-2 h-4 w-4" />
              Move to Cart
            </button>
          </div>
        </div>

        {/* Wishlist Grid/List */}
        <div className="grid gap-6">
          {view === 'grid' ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {wishlistItems.map(item => (
                  <ProductCard
                    key={item.id}
                    product={item}
                    showActions={false}
                    className="hover:shadow-md transition-shadow duration-300"
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              {wishlistItems.map(item => (
                <ProductCard
                  key={item.id}
                  product={item}
                  showActions={false}
                  className="flex flex-col items-start gap-4 p-6 bg-white rounded-xl shadow-sm border border-gray-100"
                />
              ))}
            </>
          )}
        </div>

        {/* Empty State */}
        {wishlistItems.length === 0 && (
          <div className="text-center py-12">
            <Heart className="h-12 w-12 mx-auto mb-4 text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Your wishlist is empty
            </h2>
            <p className="text-gray-600">
              Save products to your wishlist for easy access later.
            </p>
            <div className="mt-6">
              <a
                href="/products"
                className="inline-flex items-center px-6 py-3 bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
              >
                <ArrowRight className="mr-2 h-4 w-4" />
                Browse Products
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}