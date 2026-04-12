import React from 'react'

interface Props {
  filePath: string
}

export function ImageTile({ filePath }: Props): JSX.Element {
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#111111',
      overflow: 'hidden'
    }}>
      <img
        src={`contex-file://${encodeURI(filePath).replace(/#/g, '%23')}`}
        alt=""
        draggable={false}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          display: 'block'
        }}
        onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3' }}
      />
    </div>
  )
}
