import React, { createContext, useContext, useState, useCallback } from 'react'

type TileColorContextType = {
  color: string | null
  colorId: string
  fontId: string
  setColor: (color: string | null) => void
  setColorId: (id: string) => void
  setFontId: (id: string) => void
}

const TileColorContext = createContext<TileColorContextType>({
  color: null,
  colorId: 'yellow',
  fontId: 'sans',
  setColor: () => {},
  setColorId: () => {},
  setFontId: () => {},
})

export function TileColorProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [color, setColorState] = useState<string | null>(null)
  const [colorId, setColorIdState] = useState('yellow')
  const [fontId, setFontIdState] = useState('sans')
  const setColor = useCallback((c: string | null) => setColorState(c), [])
  const setColorId = useCallback((id: string) => setColorIdState(id), [])
  const setFontId = useCallback((id: string) => setFontIdState(id), [])
  return (
    <TileColorContext.Provider value={{ color, colorId, fontId, setColor, setColorId, setFontId }}>
      {children}
    </TileColorContext.Provider>
  )
}

export function useTileColor() {
  return useContext(TileColorContext)
}
