"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { rawTextData } from '@/lib/product-data';

interface Product {
  barcode: string;
  name: string;
  price: number;
}

interface QueueItem extends Product {
  qty: number;
}

// Parse product data
function parseLine(line: string): Product | null {
  const parts = line.trim().split(/\t+|\s{2,}/);
  if (parts.length < 3) return null;
  const barcode = parts[0].trim();
  const name = parts[1].trim();
  let priceStr = parts[2].trim();
  if (!priceStr.startsWith('$')) {
    for (let i = 2; i < parts.length; i++) {
      if (parts[i].trim().startsWith('$')) {
        priceStr = parts[i].trim();
        break;
      }
    }
  }
  const price = parseFloat(priceStr.replace('$', ''));
  if (!barcode || !name || isNaN(price)) return null;
  return { barcode, name, price };
}

function loadProducts(): Record<string, Product> {
  const inventory: Record<string, Product> = {};
  const lines = rawTextData.trim().split('\n');
  lines.forEach(line => {
    const p = parseLine(line);
    if (p) inventory[p.barcode] = p;
  });
  return inventory;
}

// Audio beep for scan feedback
function playBeep() {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.value = 1000;
    oscillator.type = 'sine';
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
  } catch (e) {
    console.log('Audio not supported');
  }
}

export default function BarcodeApp() {
  const { toast } = useToast();
  const [inventory, setInventory] = useState<Record<string, Product>>({});
  const [printQueue, setPrintQueue] = useState<Record<string, QueueItem>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [activeView, setActiveView] = useState<'inventory' | 'queue'>('inventory');
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  
  // Scanner states
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerMode, setScannerMode] = useState<'search' | 'new-product'>('search');
  const [continuousScan, setContinuousScan] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [scannedCount, setScannedCount] = useState(0);
  const [scanResult, setScanResult] = useState<{
    type: 'found' | 'not-found' | 'multiple';
    product?: Product;
    barcode?: string;
    matches?: Product[];
  } | null>(null);
  const [manualBarcode, setManualBarcode] = useState('');
  
  // Edit states
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editProduct, setEditProduct] = useState<Product | null>(null);
  const [editQty, setEditQty] = useState(1);
  const [editSource, setEditSource] = useState<'before-queue' | 'after-queue'>('before-queue');
  
  // Quick add states
  const [newBarcode, setNewBarcode] = useState('');
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  
  // Scanner refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<any>(null);
  const scanningRef = useRef(true);
  const lastDetectedRef = useRef<string | null>(null);
  const detectCountRef = useRef(0);

  const perPage = 100;

  // Load products and queue on mount
  useEffect(() => {
    const products = loadProducts();
    setInventory(products);
    
    // Load queue from localStorage
    try {
      const saved = localStorage.getItem('gulistan_printQueue');
      if (saved) {
        setPrintQueue(JSON.parse(saved));
      }
    } catch (e) {
      console.log('Could not load queue from localStorage');
    }
  }, []);

  // Save queue to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('gulistan_printQueue', JSON.stringify(printQueue));
    } catch (e) {
      console.log('Could not save queue to localStorage');
    }
  }, [printQueue]);

  // Filter products on search
  useEffect(() => {
    if (!searchQuery.trim()) {
      const products = Object.values(inventory);
      const end = currentPage * perPage;
      setFilteredProducts(products.slice(0, end));
      return;
    }
    const q = searchQuery.toLowerCase();
    const filtered = Object.values(inventory).filter(p =>
      p.barcode.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
    );
    setFilteredProducts(filtered.slice(0, 200));
  }, [searchQuery, inventory, currentPage]);

  // Start camera scanner
  const startScanner = useCallback(async () => {
    try {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      };
      
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      
      // Check for BarcodeDetector API
      if ('BarcodeDetector' in window) {
        const formats = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'];
        detectorRef.current = new (window as any).BarcodeDetector({ formats });
        scanningRef.current = true;
        detectBarcode();
      }
    } catch (err) {
      console.error('Camera error:', err);
      toast({
        title: 'Camera Error',
        description: 'Could not access camera. Use manual entry.',
        variant: 'destructive'
      });
    }
  }, [toast]);

  // Stop scanner
  const stopScanner = useCallback(() => {
    scanningRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    detectorRef.current = null;
  }, []);

  // Toggle torch
  const toggleTorch = useCallback(async () => {
    if (streamRef.current) {
      const track = streamRef.current.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.();
      if (capabilities && 'torch' in capabilities) {
        const newTorchState = !torchOn;
        await track.applyConstraints({
          advanced: [{ torch: newTorchState } as any]
        });
        setTorchOn(newTorchState);
      } else {
        toast({
          title: 'Torch Not Available',
          description: 'Your device does not support torch/flashlight',
          variant: 'destructive'
        });
      }
    }
  }, [torchOn, toast]);

  // Detect barcode from video stream
  const detectBarcode = useCallback(async () => {
    if (!scanningRef.current || !videoRef.current || !detectorRef.current) return;
    
    try {
      const barcodes = await detectorRef.current.detect(videoRef.current);
      
      if (barcodes.length > 0) {
        const barcode = barcodes[0].rawValue;
        
        // Require only 1 consecutive detection for faster scanning
        if (barcode === lastDetectedRef.current) {
          detectCountRef.current++;
          if (detectCountRef.current >= 1) {
            playBeep();
            handleBarcodeDetected(barcode);
            return;
          }
        } else {
          lastDetectedRef.current = barcode;
          detectCountRef.current = 1;
        }
      }
    } catch (e) {
      // Continue scanning on error
    }
    
    if (scanningRef.current) {
      requestAnimationFrame(detectBarcode);
    }
  }, []);

  // Handle barcode detected
  const handleBarcodeDetected = useCallback((barcode: string) => {
    const cleanBarcode = barcode.trim();
    
    if (scannerMode === 'new-product') {
      setNewBarcode(cleanBarcode);
      stopScanner();
      setScannerOpen(false);
      toast({ title: 'Barcode scanned', description: 'Enter product name and price' });
      return;
    }
    
    // Check for exact match
    if (inventory[cleanBarcode]) {
      setScanResult({
        type: 'found',
        product: inventory[cleanBarcode]
      });
      if (!continuousScan) {
        stopScanner();
      }
      return;
    }
    
    // Smart matching
    const matches = findSmartMatches(cleanBarcode);
    if (matches.length > 0) {
      setScanResult({
        type: matches.length > 1 ? 'multiple' : 'found',
        product: matches[0],
        matches: matches.length > 1 ? matches : undefined
      });
      if (!continuousScan) {
        stopScanner();
      }
      return;
    }
    
    // Not found
    setScanResult({
      type: 'not-found',
      barcode: cleanBarcode
    });
    if (!continuousScan) {
      stopScanner();
    }
  }, [scannerMode, inventory, continuousScan, stopScanner, toast]);

  // Smart matching for barcodes
  const findSmartMatches = (barcode: string): Product[] => {
    const results: Product[] = [];
    const cleanBarcode = barcode.replace(/\D/g, '');
    
    for (const key in inventory) {
      const p = inventory[key];
      const cleanKey = key.replace(/\D/g, '');
      
      // Digit match
      if (cleanBarcode && cleanKey && (cleanKey.includes(cleanBarcode) || cleanBarcode.includes(cleanKey))) {
        results.push(p);
        continue;
      }
      
      // Name match
      if (p.name.toLowerCase().includes(barcode.toLowerCase())) {
        results.push(p);
      }
      
      if (results.length >= 5) break;
    }
    
    return results;
  };

  // Add to queue
  const addToQueue = useCallback((product: Product, qty: number = 1) => {
    setPrintQueue(prev => {
      const existing = prev[product.barcode];
      return {
        ...prev,
        [product.barcode]: {
          ...product,
          qty: existing ? existing.qty + qty : qty
        }
      };
    });
    setScannedCount(prev => prev + 1);
    toast({ title: 'Added to queue', description: `${product.name} x${qty}` });
  }, [toast]);

  // Open edit modal before adding to queue
  const openEditBeforeQueue = useCallback((product: Product) => {
    setEditProduct({ ...product });
    setEditQty(1);
    setEditSource('before-queue');
    setEditModalOpen(true);
  }, []);

  // Open edit modal for queue item
  const openEditAfterQueue = useCallback((barcode: string) => {
    const item = printQueue[barcode];
    if (item) {
      setEditProduct({ barcode: item.barcode, name: item.name, price: item.price });
      setEditQty(item.qty);
      setEditSource('after-queue');
      setEditModalOpen(true);
    }
  }, [printQueue]);

  // Save edit
  const saveEdit = useCallback(() => {
    if (!editProduct) return;
    
    if (editSource === 'before-queue') {
      // Add to queue with edited values
      addToQueue(editProduct, editQty);
      setEditModalOpen(false);
      setEditProduct(null);
      
      if (continuousScan && scannerOpen) {
        setScanResult(null);
        setManualBarcode('');
        if (!streamRef.current) {
          startScanner();
        }
      } else {
        setScannerOpen(false);
      }
    } else {
      // Update queue item
      const oldBarcode = Object.keys(printQueue).find(b => printQueue[b] === editProduct);
      if (oldBarcode) {
        setPrintQueue(prev => {
          const newQueue = { ...prev };
          delete newQueue[oldBarcode];
          const existing = newQueue[editProduct.barcode];
          newQueue[editProduct.barcode] = {
            ...editProduct,
            qty: existing ? existing.qty + editQty : editQty
          };
          return newQueue;
        });
        
        // Update inventory if barcode changed
        setInventory(prev => ({
          ...prev,
          [editProduct.barcode]: editProduct
        }));
      }
      setEditModalOpen(false);
      setEditProduct(null);
      toast({ title: 'Updated', description: 'Product details saved' });
    }
  }, [editProduct, editQty, editSource, addToQueue, continuousScan, scannerOpen, startScanner, printQueue, toast]);

  // Remove from queue
  const removeFromQueue = useCallback((barcode: string) => {
    setPrintQueue(prev => {
      const newQueue = { ...prev };
      delete newQueue[barcode];
      return newQueue;
    });
    toast({ title: 'Removed', description: 'Item removed from queue' });
  }, [toast]);

  // Update quantity
  const updateQty = useCallback((barcode: string, delta: number) => {
    setPrintQueue(prev => {
      const item = prev[barcode];
      if (!item) return prev;
      const newQty = item.qty + delta;
      if (newQty <= 0) {
        const newQueue = { ...prev };
        delete newQueue[barcode];
        return newQueue;
      }
      return {
        ...prev,
        [barcode]: { ...item, qty: newQty }
      };
    });
  }, []);

  // Clear queue
  const clearQueue = useCallback(() => {
    if (confirm('Clear all items from queue?')) {
      setPrintQueue({});
      toast({ title: 'Queue cleared' });
    }
  }, [toast]);

  // Handle manual scan
  const handleManualScan = useCallback(() => {
    if (manualBarcode.trim()) {
      handleBarcodeDetected(manualBarcode.trim());
    }
  }, [manualBarcode, handleBarcodeDetected]);

  // Add new product
  const addNewProduct = useCallback(() => {
    if (!newBarcode.trim() || !newName.trim() || isNaN(parseFloat(newPrice))) {
      toast({ title: 'Fill all fields', variant: 'destructive' });
      return;
    }
    const product: Product = {
      barcode: newBarcode.trim(),
      name: newName.trim(),
      price: parseFloat(newPrice)
    };
    setInventory(prev => ({ ...prev, [product.barcode]: product }));
    addToQueue(product);
    setNewBarcode('');
    setNewName('');
    setNewPrice('');
  }, [newBarcode, newName, newPrice, addToQueue, toast]);

  // Save scanned new product
  const saveScannedProduct = useCallback((barcode: string) => {
    const nameInput = document.getElementById('scan-new-name') as HTMLInputElement;
    const priceInput = document.getElementById('scan-new-price') as HTMLInputElement;
    const name = nameInput?.value.trim();
    const price = parseFloat(priceInput?.value || '');
    
    if (!name || isNaN(price)) {
      toast({ title: 'Enter name and price', variant: 'destructive' });
      return;
    }
    
    const product: Product = { barcode, name, price };
    setInventory(prev => ({ ...prev, [product.barcode]: product }));
    addToQueue(product);
    setScannerOpen(false);
    toast({ title: 'Saved', description: name });
  }, [addToQueue, toast]);

  // Continue scanning
  const continueScanning = useCallback(() => {
    setScanResult(null);
    setManualBarcode('');
    startScanner();
  }, [startScanner]);

  // Print functions
  const printDirect = useCallback(() => {
    const items = Object.values(printQueue);
    if (!items.length) {
      toast({ title: 'Queue empty', variant: 'destructive' });
      return;
    }
    
    let printFrame = document.getElementById('print-frame') as HTMLIFrameElement;
    if (!printFrame) {
      printFrame = document.createElement('iframe');
      printFrame.id = 'print-frame';
      printFrame.style.cssText = 'position:absolute;top:-10000px;left:-10000px;';
      document.body.appendChild(printFrame);
    }
    
    const doc = printFrame.contentWindow?.document;
    if (!doc) return;
    
    let html = `<!DOCTYPE html><html><head><title>Print Labels</title>
<style>
@page { size: A4; margin: 0; }
body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
.labels-grid { display: grid; grid-template-columns: repeat(3, 70mm); grid-template-rows: repeat(6, 45mm); gap: 0; }
.label { width: 70mm; height: 45mm; padding: 2mm; text-align: center; page-break-inside: avoid; display: flex; flex-direction: column; justify-content: center; align-items: center; box-sizing: border-box; gap: 0; }
.price { font-size: 18pt; font-weight: 900; color: #000; margin: 0; line-height: 1; padding: 0; }
.name { font-size: 12pt; font-weight: bold; color: #000; max-width: 66mm; text-transform: uppercase; line-height: 1; margin: 0; padding: 0; }
.barcode-img { margin: 0; padding: 0; }
.barcode-img svg { max-width: 62mm; }
.barcode-number { font-size: 7pt; font-family: Arial, sans-serif; color: #000; margin: 0; }
</style>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
</head><body><div class="labels-grid">`;
    
    let bcIndex = 0;
    const barcodeData: { id: number; barcode: string }[] = [];
    items.forEach(item => {
      for (let i = 0; i < item.qty; i++) {
        html += `<div class="label">
          <div class="price">$${item.price.toFixed(2)}</div>
          <div class="name">${item.name.toUpperCase()}</div>
          <svg id="bc${bcIndex}" class="barcode-img"></svg>
          <div class="barcode-number">${item.barcode}</div>
        </div>`;
        barcodeData.push({ id: bcIndex, barcode: item.barcode });
        bcIndex++;
      }
    });
    
    html += '</div><script>';
    barcodeData.forEach(bd => {
      html += `JsBarcode("#bc${bd.id}","${bd.barcode}",{width:1.5,height:18,displayValue:false,margin:1});`;
    });
    html += 'setTimeout(()=>{window.print();},300);<\/script></body></html>';
    
    doc.open();
    doc.write(html);
    doc.close();
    
    toast({ title: 'Sending to printer...' });
  }, [printQueue, toast]);

  // Open scanner
  const openScanner = useCallback((mode: 'search' | 'new-product' = 'search') => {
    setScannerMode(mode);
    setScannerOpen(true);
    setScanResult(null);
    setManualBarcode('');
    setScannedCount(0);
  }, []);

  // Close scanner
  const closeScannerModal = useCallback(() => {
    stopScanner();
    setScannerOpen(false);
    setScanResult(null);
  }, [stopScanner]);

  // Open scanner on modal open
  useEffect(() => {
    if (scannerOpen) {
      startScanner();
    }
    return () => {
      if (!scannerOpen) {
        stopScanner();
      }
    };
  }, [scannerOpen, startScanner, stopScanner]);

  const queueTotal = Object.values(printQueue).reduce((sum, item) => sum + (item.price * item.qty), 0);
  const queueCount = Object.values(printQueue).reduce((sum, item) => sum + item.qty, 0);

  return (
    <div className="min-h-screen bg-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white shadow-sm">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
              </svg>
            </div>
            <span className="font-bold text-lg text-slate-800 hidden sm:inline">Gulistan Barcode</span>
          </div>
          
          <div className="flex items-center gap-2">
            <Button 
              onClick={() => openScanner('search')}
              className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="hidden sm:inline">Scan</span>
            </Button>
            
            <Button 
              variant="outline"
              onClick={() => setActiveView(activeView === 'inventory' ? 'queue' : 'inventory')}
              className="relative"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              <span className="hidden sm:inline">Queue</span>
              {queueCount > 0 && (
                <Badge className="absolute -top-2 -right-2 px-2 py-0.5 text-xs">
                  {queueCount}
                </Badge>
              )}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        {activeView === 'inventory' ? (
          <>
            {/* Search Bar */}
            <div className="bg-white rounded-full shadow-md px-4 py-3 flex items-center gap-3 mb-6">
              <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Input
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="border-0 focus-visible:ring-0 text-base"
              />
              <Button 
                onClick={() => openScanner('search')}
                variant="ghost"
                size="icon"
                className="rounded-full"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                </svg>
              </Button>
            </div>

            {/* Stats */}
            <Card className="mb-6">
              <CardContent className="py-4 flex justify-between items-center">
                <span className="text-slate-600">
                  <svg className="w-5 h-5 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                  <strong>{Object.keys(inventory).length}</strong> products
                </span>
                <span className="text-slate-500 text-sm">
                  Showing <strong>{filteredProducts.length}</strong>
                </span>
              </CardContent>
            </Card>

            {/* Quick Add */}
            <Card className="mb-6">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg text-blue-600 flex items-center gap-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Quick Add
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Barcode"
                      value={newBarcode}
                      onChange={(e) => setNewBarcode(e.target.value)}
                      className="flex-1"
                    />
                    <Button 
                      onClick={() => openScanner('new-product')}
                      variant="outline"
                      size="icon"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      </svg>
                    </Button>
                  </div>
                  <Input
                    placeholder="Name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Price"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value)}
                  />
                  <Button onClick={addNewProduct} className="w-full">
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Add
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Product List */}
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Barcode</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Product</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Price</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-slate-700">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredProducts.map((product) => (
                      <tr key={product.barcode} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-sm text-slate-600 max-w-[120px] truncate">{product.barcode}</td>
                        <td className="px-4 py-3 text-sm text-slate-800 max-w-[200px] truncate">{product.name}</td>
                        <td className="px-4 py-3 text-sm font-bold text-blue-600">${product.price.toFixed(2)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEditProduct(product);
                                setEditQty(1);
                                setEditSource('before-queue');
                                setEditModalOpen(true);
                              }}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => addToQueue(product)}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                              </svg>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredProducts.length === 0 && (
                  <div className="py-12 text-center text-slate-500">
                    <svg className="w-12 h-12 mx-auto mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                    </svg>
                    <p>No products found</p>
                  </div>
                )}
              </div>
            </Card>
          </>
        ) : (
          /* Queue View */
          <>
            <Card className="mb-6">
              <CardContent className="py-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  <span className="font-semibold">Print Queue</span>
                  <Badge variant="secondary">{queueCount} items</Badge>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setActiveView('inventory')}>
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                    </svg>
                    Back
                  </Button>
                  <Button variant="destructive" onClick={clearQueue}>
                    <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Clear
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="mb-6">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Product</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Price</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Qty</th>
                      <th className="px-4 py-3 text-left text-sm font-semibold text-slate-700">Total</th>
                      <th className="px-4 py-3 text-right text-sm font-semibold text-slate-700">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {Object.entries(printQueue).map(([barcode, item]) => (
                      <tr key={barcode} className="hover:bg-slate-50">
                        <td className="px-4 py-3">
                          <div className="text-xs text-slate-500">{barcode}</div>
                          <div className="font-medium">{item.name}</div>
                        </td>
                        <td className="px-4 py-3 font-medium">${item.price.toFixed(2)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => updateQty(barcode, -1)}
                            >
                              -
                            </Button>
                            <span className="w-10 text-center font-medium">{item.qty}</span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => updateQty(barcode, 1)}
                            >
                              +
                            </Button>
                          </div>
                        </td>
                        <td className="px-4 py-3 font-bold">${(item.price * item.qty).toFixed(2)}</td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openEditAfterQueue(barcode)}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => removeFromQueue(barcode)}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Object.keys(printQueue).length === 0 && (
                  <div className="py-12 text-center text-slate-500">
                    <svg className="w-12 h-12 mx-auto mb-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    <p>Queue is empty</p>
                  </div>
                )}
              </div>
              {Object.keys(printQueue).length > 0 && (
                <div className="border-t p-4 bg-slate-50">
                  <div className="flex justify-between items-center">
                    <span className="font-semibold">Total:</span>
                    <span className="text-xl font-bold text-blue-600">${queueTotal.toFixed(2)}</span>
                  </div>
                </div>
              )}
            </Card>

            {/* Print Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Button onClick={printDirect} className="py-6 text-lg">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Print Direct
              </Button>
              <Button variant="outline" className="py-6 text-lg">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                </svg>
                Preview Labels
              </Button>
              <Button variant="outline" className="py-6 text-lg">
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                Print List
              </Button>
            </div>
          </>
        )}
      </main>

      {/* Scanner Modal */}
      <Dialog open={scannerOpen} onOpenChange={(open) => !open && closeScannerModal()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>Barcode Scanner</span>
              {scannedCount > 0 && (
                <Badge variant="secondary" className="ml-2">
                  {scannedCount} scanned
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {/* Scanner Controls */}
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  checked={continuousScan}
                  onCheckedChange={setContinuousScan}
                />
                <Label htmlFor="continuous" className="text-sm">Keep Scanning</Label>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={toggleTorch}
                className={torchOn ? 'bg-yellow-100' : ''}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Torch
              </Button>
            </div>

            {/* Video Scanner */}
            <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
              />
              {streamRef.current && (
                <div className="absolute top-2 right-2 bg-green-500 text-white px-2 py-1 rounded-full text-xs flex items-center gap-1 animate-pulse">
                  <span className="w-2 h-2 bg-white rounded-full"></span>
                  Scanning...
                </div>
              )}
            </div>

            {/* Scan Result */}
            {scanResult && (
              <div className="space-y-3">
                {scanResult.type === 'found' && scanResult.product && (
                  <div className="bg-blue-50 rounded-lg p-4 text-center">
                    <div className="text-lg font-bold">{scanResult.product.name}</div>
                    <div className="text-3xl font-bold text-blue-600 my-2">${scanResult.product.price.toFixed(2)}</div>
                    <div className="text-sm text-slate-500">{scanResult.product.barcode}</div>
                  </div>
                )}
                
                {scanResult.type === 'multiple' && scanResult.matches && (
                  <div className="bg-blue-50 rounded-lg p-4 text-center">
                    <div className="text-lg font-bold">{scanResult.product?.name}</div>
                    <div className="text-3xl font-bold text-blue-600 my-2">${scanResult.product?.price.toFixed(2)}</div>
                    <div className="text-sm text-slate-500">{scanResult.product?.barcode}</div>
                    <div className="text-xs text-slate-400 mt-2">+{scanResult.matches.length - 1} more matches</div>
                  </div>
                )}
                
                {scanResult.type === 'not-found' && scanResult.barcode && (
                  <div className="bg-red-50 rounded-lg p-4 text-center">
                    <svg className="w-10 h-10 mx-auto text-red-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div className="font-semibold mb-2">Product Not Found</div>
                    <div className="font-mono bg-white px-2 py-1 rounded text-sm">{scanResult.barcode}</div>
                    
                    <div className="mt-4 space-y-2">
                      <Input id="scan-new-name" placeholder="Product Name" />
                      <Input id="scan-new-price" type="number" step="0.01" placeholder="Price ($)" />
                      <Button 
                        className="w-full"
                        onClick={() => saveScannedProduct(scanResult.barcode!)}
                      >
                        Save & Add
                      </Button>
                    </div>
                  </div>
                )}
                
                {scanResult.product && scanResult.type !== 'not-found' && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => openEditBeforeQueue(scanResult.product!)}
                    >
                      <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Edit & Add
                    </Button>
                    <Button
                      className="flex-1"
                      onClick={() => {
                        addToQueue(scanResult.product!);
                        if (continuousScan) {
                          setScanResult(null);
                          setManualBarcode('');
                          if (!streamRef.current) {
                            startScanner();
                          }
                        } else {
                          setScannerOpen(false);
                        }
                      }}
                    >
                      <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                      </svg>
                      Add Another
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={continueScanning}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      </svg>
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Manual Entry */}
            <div className="pt-2 border-t">
              <p className="text-sm text-slate-500 text-center mb-2">Or enter manually:</p>
              <div className="flex gap-2">
                <Input
                  placeholder="Enter barcode"
                  value={manualBarcode}
                  onChange={(e) => setManualBarcode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleManualScan()}
                />
                <Button onClick={handleManualScan}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Modal */}
      <Dialog open={editModalOpen} onOpenChange={setEditModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editSource === 'before-queue' ? 'Edit Before Adding' : 'Edit Queue Item'}
            </DialogTitle>
          </DialogHeader>
          
          {editProduct && (
            <div className="space-y-4">
              <div>
                <Label>Barcode</Label>
                <Input
                  value={editProduct.barcode}
                  onChange={(e) => setEditProduct({ ...editProduct, barcode: e.target.value })}
                  disabled={editSource === 'before-queue'}
                />
              </div>
              <div>
                <Label>Product Name</Label>
                <Input
                  value={editProduct.name}
                  onChange={(e) => setEditProduct({ ...editProduct, name: e.target.value })}
                />
              </div>
              <div>
                <Label>Price ($)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={editProduct.price}
                  onChange={(e) => setEditProduct({ ...editProduct, price: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <div>
                <Label>Quantity</Label>
                <Input
                  type="number"
                  min="1"
                  value={editQty}
                  onChange={(e) => setEditQty(parseInt(e.target.value) || 1)}
                />
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveEdit}>
              <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {editSource === 'before-queue' ? 'Add to Queue' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
