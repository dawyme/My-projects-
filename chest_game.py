import random
import time

def print_slow(text):
    for char in text:
        print(char, end='', flush=True)
        time.sleep(0.02)
    print()

def main():
    print_slow("=== Welcome to Chest Adventure! ===")
    print_slow("You are an adventurer seeking treasure.")
    print_slow("Open chests to find loot, but beware of traps!\n")

    gold = 0
    inventory = []
    health = 100
    max_health = 100

    while True:
        print_slow(f"\nStatus: Gold: {gold} | Health: {health}/{max_health} | Inventory: {', '.join(inventory) if inventory else 'Empty'}")
        print_slow("What would you like to do?")
        print_slow("1. Open a chest")
        print_slow("2. Check inventory")
        print_slow("3. Rest (costs 10 gold, restores 20 health)")
        print_slow("4. Quit")

        choice = input("> ").strip()

        if choice == "1":
            open_chest(gold, inventory, health)
            # Since we need to update variables, we'll return new values
            # For simplicity, we'll handle inside function with mutable containers
            # Let's redesign: use mutable dict
        elif choice == "2":
            if inventory:
                print_slow("Inventory:")
                for item in inventory:
                    print_slow(f"  - {item}")
            else:
                print_slow("Your inventory is empty.")
        elif choice == "3":
            if gold >= 10:
                gold -= 10
                heal_amount = min(20, max_health - health)
                health += heal_amount
                print_slow(f"You rest and recover {heal_amount} health. (Cost: 10 gold)")
            else:
                print_slow("You don't have enough gold to rest.")
        elif choice == "4":
            print_slow("Thanks for playing!")
            break
        else:
            print_slow("Invalid choice. Please try again.")

def open_chest(state):
    gold = state['gold']
    inventory = state['inventory']
    health = state['health']
    max_health = state['max_health']

    print_slow("\nYou approach a mysterious chest...")
    time.sleep(0.5)

    # Determine chest outcome
    roll = random.randint(1, 100)
    if roll <= 10:  # 10% chance trap
        print_slow("💥 TRAP! The chest explodes!")
        damage = random.randint(15, 30)
        health -= damage
        print_slow(f"You take {damage} damage!")
        if health <= 0:
            print_slow("You have fallen in your adventure...")
            state['health'] = health
            return False  # game over
    elif roll <= 30:  # 20% chance small loot
        loot_gold = random.randint(5, 20)
        gold += loot_gold
        print_slow(f"🪙 You found {loot_gold} gold!")
    elif roll <= 60:  # 30% chance medium loot
        loot_gold = random.randint(20, 50)
        gold += loot_gold
        print_slow(f"🪙🪙 You found {loot_gold} gold!")
        # small chance for item
        if random.random() < 0.3:
            item = random.choice(["Healing Potion", "Iron Key", "Ancient Scroll"])
            inventory.append(item)
            print_slow(f"🎒 You also found a {item}!")
    else:  # 40% chance great loot
        loot_gold = random.randint(50, 150)
        gold += loot_gold
        print_slow(f"🪙🪙🪙 You found {loot_gold} gold!")
        # higher chance for item
        if random.random() < 0.5:
            item = random.choice(["Healing Potion", "Iron Key", "Ancient Scroll", "Magic Sword", "Shield of Light"])
            inventory.append(item)
            print_slow(f"🎒 You also found a {item}!")
        # rare chance for extra health
        if random.random() < 0.1:
            heal = random.randint(10, 25)
            health = min(max_health, health + heal)
            print_slow(f"❤️ You feel revitalized! (+{heal} health)")

    state['gold'] = gold
    state['inventory'] = inventory
    state['health'] = health
    state['max_health'] = max_health
    return True

if __name__ == "__main__":
    # Use a dict to allow mutation inside functions
    game_state = {
        'gold': 0,
        'inventory': [],
        'health': 100,
        'max_health': 100
    }

    print_slow("=== Welcome to Chest Adventure! ===")
    print_slow("You are an adventurer seeking treasure.")
    print_slow("Open chests to find loot, but beware of traps!\n")

    while True:
        print_slow(f"\nStatus: Gold: {game_state['gold']} | Health: {game_state['health']}/{game_state['max_health']} | Inventory: {', '.join(game_state['inventory']) if game_state['inventory'] else 'Empty'}")
        print_slow("What would you like to do?")
        print_slow("1. Open a chest")
        print_slow("2. Check inventory")
        print_slow("3. Rest (costs 10 gold, restores 20 health)")
        print_slow("4. Quit")

        choice = input("> ").strip()

        if choice == "1":
            alive = open_chest(game_state)
            if not alive:
                print_slow("Game Over!")
                break
        elif choice == "2":
            if game_state['inventory']:
                print_slow("Inventory:")
                for item in game_state['inventory']:
                    print_slow(f"  - {item}")
            else:
                print_slow("Your inventory is empty.")
        elif choice == "3":
            if game_state['gold'] >= 10:
                game_state['gold'] -= 10
                heal_amount = min(20, game_state['max_health'] - game_state['health'])
                game_state'])
                game_state['health'] += heal_amount
                print_slow(f"You rest and recover {heal_amount} health. (Cost: 10 gold)")
            else:
                print_slow("You don't have enough gold to rest.")
        elif choice == "4":
            print_slow("Thanks for playing!")
            break
        else:
            print_slow("Invalid choice. Please try again.")