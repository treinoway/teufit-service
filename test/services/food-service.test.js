import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchFoods, getFoodById, listFoodGroups } from '../../src/services/food-service.js';

const makePrisma = (overrides = {}) => ({
  food: {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
  },
  foodGroup: {
    findMany: vi.fn().mockResolvedValue([]),
  },
  $transaction: vi.fn((ops) => Promise.all(ops)),
  ...overrides,
});

describe('searchFoods', () => {
  let db;

  beforeEach(() => {
    db = makePrisma();
  });

  it('defaults source to taco', async () => {
    await searchFoods(db);
    // findMany is called inside the transaction array; check the where passed
    expect(db.food.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'taco' }) }),
    );
  });

  it('passes source=tbca when explicitly set', async () => {
    await searchFoods(db, { source: 'tbca' });
    expect(db.food.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'tbca' }) }),
    );
  });

  it('applies name filter when query is provided', async () => {
    await searchFoods(db, { query: 'arroz' });
    expect(db.food.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: 'arroz', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('applies groupId filter when provided', async () => {
    await searchFoods(db, { groupId: 'group-uuid' });
    expect(db.food.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ foodGroupId: 'group-uuid' }),
      }),
    );
  });

  it('returns items and total', async () => {
    const fakeFood = { id: 'f1', name: 'Arroz', source: 'taco' };
    db.food.findMany.mockResolvedValue([fakeFood]);
    db.food.count.mockResolvedValue(1);
    db.$transaction.mockImplementation((ops) => Promise.all(ops));

    const result = await searchFoods(db, { query: 'arroz' });
    expect(result).toEqual({ items: [fakeFood], total: 1 });
  });
});

describe('getFoodById', () => {
  it('returns food when found', async () => {
    const food = { id: 'f1', name: 'Arroz', source: 'taco' };
    const db = makePrisma();
    db.food.findUnique.mockResolvedValue(food);

    await expect(getFoodById(db, 'f1')).resolves.toEqual(food);
  });

  it('throws 404 when not found', async () => {
    const db = makePrisma();
    db.food.findUnique.mockResolvedValue(null);

    await expect(getFoodById(db, 'missing')).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('listFoodGroups', () => {
  it('returns all food groups ordered by name', async () => {
    const db = makePrisma();
    const groups = [{ id: 'g1', name: 'Cereais', code: 'cereais' }];
    db.foodGroup.findMany.mockResolvedValue(groups);

    await expect(listFoodGroups(db)).resolves.toEqual(groups);
    expect(db.foodGroup.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
  });
});
